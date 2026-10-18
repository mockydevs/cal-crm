import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  cellOf,
  ImportFileError,
  IMPORT_FILE_LIMITS,
  openCsvFile,
  type CsvFileLimits,
  type CsvRow,
} from './csv-file.js';

/** A stream that hands the bytes over in pieces of the given size. */
function inPieces(bytes: Buffer, size: number): Readable {
  const pieces: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += size) pieces.push(bytes.subarray(at, at + size));
  return Readable.from(pieces);
}

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');

async function read(
  bytes: Buffer,
  options: { delimiter?: ',' | ';' | '\t' | '|'; limits?: CsvFileLimits; size?: number } = {},
): Promise<{ delimiter: string; header: readonly string[]; rows: CsvRow[] }> {
  const { size = 7, ...rest } = options;
  const file = await openCsvFile(inPieces(bytes, size), rest);
  const rows: CsvRow[] = [];
  for await (const row of file.rows()) rows.push(row);
  return { delimiter: file.delimiter, header: file.header, rows };
}

async function problemOf(work: Promise<unknown>): Promise<ImportFileError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ImportFileError) return error;
    throw error;
  }
  throw new Error('The file was read.');
}

const limits = (changes: Partial<CsvFileLimits>): CsvFileLimits => ({
  ...IMPORT_FILE_LIMITS,
  ...changes,
});

describe('openCsvFile', () => {
  it('reads the header and the rows of data, whatever pieces the bytes come in', async () => {
    const bytes = utf8(
      'First Name, Email ,Phone\r\nMaya,maya@example.test,+254712345678\r\n"Kip, Jr",kip@example.test,\r\n',
    );
    const expected = {
      delimiter: ',',
      header: ['First Name', 'Email', 'Phone'],
      rows: [
        { row: 2, index: 0, cells: ['Maya', 'maya@example.test', '+254712345678'] },
        { row: 3, index: 1, cells: ['Kip, Jr', 'kip@example.test', ''] },
      ],
    };
    for (const size of [1, 2, 3, 5, 64, bytes.length])
      expect(await read(bytes, { size })).toEqual(expected);
  });

  it('reads UTF-8 with a byte order mark, and letters cut across two pieces of bytes', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      utf8('Name,City\r\nZoë Müller,Malmö\r\n王芳,北京\r\n'),
    ]);
    for (const size of [1, 2, 3, 4])
      expect(await read(bytes, { size })).toEqual({
        delimiter: ',',
        header: ['Name', 'City'],
        rows: [
          { row: 2, index: 0, cells: ['Zoë Müller', 'Malmö'] },
          { row: 3, index: 1, cells: ['王芳', '北京'] },
        ],
      });
  });

  it('refuses bytes that are not UTF-8: UTF-16, and Windows-1252 with accented letters', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name\r\nZoë', 'utf16le')]);
    const windows1252 = Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0d, 0x0a, 0x5a, 0x6f, 0xeb]);
    for (const bytes of [utf16, windows1252]) {
      const problem = await problemOf(read(bytes));
      expect(problem.code).toBe('not_utf8');
      expect(problem.message).toBe(
        'This file is not saved as UTF-8. Save it as "CSV UTF-8" in your spreadsheet and upload it again.',
      );
    }
    // A file that stops in the middle of a letter.
    expect((await problemOf(read(Buffer.from([0x61, 0x0a, 0xc3])))).code).toBe('not_utf8');
  });

  it('refuses a file with NUL characters, as UTF-16 without its mark reads', async () => {
    const problem = await problemOf(read(Buffer.from('Name\r\nZo', 'utf16le')));
    expect(problem.code).toBe('nul_character');
  });

  it('finds the delimiter from the first row, and takes the one it is told', async () => {
    expect(await read(utf8('Name;Email\r\nMaya;m@example.test\r\n'))).toMatchObject({
      delimiter: ';',
      header: ['Name', 'Email'],
      rows: [{ cells: ['Maya', 'm@example.test'] }],
    });
    expect(await read(utf8('Name\tEmail\nMaya\tm@example.test'))).toMatchObject({
      delimiter: '\t',
      rows: [{ cells: ['Maya', 'm@example.test'] }],
    });
    // Told a comma, a semicolon is data.
    expect(await read(utf8('Name;Email\r\na;b\r\n'), { delimiter: ',' })).toMatchObject({
      delimiter: ',',
      header: ['Name;Email'],
      rows: [{ cells: ['a;b'] }],
    });
    // A header longer than one piece of bytes is still read whole before choosing.
    const wide = `${Array.from({ length: 40 }, (_cell, at) => `Column ${String(at)}`).join('|')}\r\n`;
    expect((await read(utf8(wide), { size: 16 })).header).toHaveLength(40);
  });

  it('leaves blank rows out without renumbering the rows after them', async () => {
    const { rows } = await read(
      utf8('Name,Email\r\n\r\n , \r\nMaya,m@example.test\r\n,,\r\nKip,\r\n\r\n'),
    );
    expect(rows).toEqual([
      { row: 4, index: 0, cells: ['Maya', 'm@example.test'] },
      { row: 6, index: 1, cells: ['Kip', ''] },
    ]);
  });

  it('keeps a row as long or as short as it is, and line breaks inside quotes', async () => {
    const { rows } = await read(utf8('A,B,C\r\n1\r\n1,2,3,4\r\n"two\r\nlines",x,y\r\n'));
    expect(rows).toEqual([
      { row: 2, index: 0, cells: ['1'] },
      { row: 3, index: 1, cells: ['1', '2', '3', '4'] },
      { row: 4, index: 2, cells: ['two\r\nlines', 'x', 'y'] },
    ]);
  });

  it('refuses a file with no header: empty, or blank in its first row', async () => {
    for (const text of ['', '\r\n', ',,\r\nMaya,m@example.test\r\n']) {
      const problem = await problemOf(read(utf8(text)));
      expect(problem).toMatchObject({ code: 'header_missing', row: 1 });
    }
  });

  it('refuses a file over its row limit at the first row past it, not before', async () => {
    const text = 'Name\r\na\r\n\r\nb\r\nc\r\n';
    expect((await read(utf8(text), { limits: limits({ rows: 3 }) })).rows).toHaveLength(3);
    const problem = await problemOf(read(utf8(text), { limits: limits({ rows: 2 }) }));
    expect(problem).toMatchObject({ code: 'too_many_rows', row: 5 });
    expect(problem.message).toBe(
      'This file has more than 2 rows. Split it into smaller files and import them one after another.',
    );
  });

  it('refuses a cell, a row or a column count over its limit, naming the row', async () => {
    expect(
      await problemOf(read(utf8('A,B\r\nxxxxx,y\r\n'), { limits: limits({ cellLength: 4 }) })),
    ).toMatchObject({ code: 'field_too_long', row: 2 });
    expect(
      await problemOf(read(utf8('A,B\r\nxxx,yyy\r\n'), { limits: limits({ rowLength: 5 }) })),
    ).toMatchObject({ code: 'record_too_long', row: 2 });
    expect(
      await problemOf(read(utf8('A,B\r\n1,2,3\r\n'), { limits: limits({ columns: 2 }) })),
    ).toMatchObject({ code: 'too_many_fields', row: 2 });
    expect(
      await problemOf(read(utf8('A,B,C\r\n'), { limits: limits({ columns: 2 }) })),
    ).toMatchObject({ code: 'too_many_fields', row: 1 });
  });

  it('refuses a huge unbroken value without reading it to its end', async () => {
    // Ten megabytes with no line break: the limit stops it at the first piece past it.
    let handed = 0;
    const endless = new Readable({
      read() {
        handed += 1;
        this.push(handed > 160 ? null : Buffer.alloc(65_536, 0x78));
      },
    });
    const problem = await problemOf(openCsvFile(endless, { limits: limits({ cellLength: 1000 }) }));
    expect(problem).toMatchObject({ code: 'field_too_long', row: 1 });
    expect(handed).toBeLessThan(10);
    expect(endless.destroyed).toBe(true);
  });

  it('refuses malformed quoting with the row it is in', async () => {
    expect(await problemOf(read(utf8('A,B\r\nx,y"z\r\n')))).toMatchObject({
      code: 'stray_quote',
      row: 2,
      message: 'Row 2 has a quotation mark inside a value that is not quoted.',
    });
    expect(await problemOf(read(utf8('A,B\r\n"x,y\r\nz\r\n')))).toMatchObject({
      code: 'unterminated_quote',
      row: 2,
    });
  });

  it('lets go of the file when reading stops early, and when it is closed', async () => {
    const stopped = inPieces(utf8('A\r\n1\r\n2\r\n3\r\n'), 2);
    const file = await openCsvFile(stopped);
    for await (const row of file.rows()) if (row.index === 0) break;
    expect(stopped.destroyed).toBe(true);

    const closed = inPieces(utf8('A\r\n1\r\n'), 2);
    (await openCsvFile(closed)).close();
    expect(closed.destroyed).toBe(true);
  });

  it('passes on a failure of the stream itself', async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('the disk went away'));
      },
    });
    await expect(openCsvFile(broken)).rejects.toThrow('the disk went away');
  });
});

describe('cellOf', () => {
  it('gives a cell trimmed, and nothing for a column the row does not reach', () => {
    const row = { row: 2, index: 0, cells: ['  Maya ', '=1+1', ''] };
    expect(cellOf(row, 0)).toBe('Maya');
    expect(cellOf(row, 1)).toBe('=1+1');
    expect(cellOf(row, 2)).toBe('');
    expect(cellOf(row, 9)).toBe('');
  });
});
