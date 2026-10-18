// A record's documents are known by their names and checked by their first bytes: the
// formats GoHighLevel's file upload field takes, and nothing a browser could run.
import { documentFormats } from '@repo/contracts';
import { ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { checkDocument } from './documents.js';

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Buffer.concat(
    parts.map((part) =>
      typeof part === 'string' ? Buffer.from(part, 'ascii') : Buffer.from(part),
    ),
  );
const zip = bytes([0x50, 0x4b, 0x03, 0x04], 'rest');
const compound = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 'rest');
const heads: Record<string, Uint8Array> = {
  'brief.pdf': bytes('%PDF-1.7'),
  'old.doc': compound,
  'brief.docx': zip,
  'photo.jpg': bytes([0xff, 0xd8, 0xff, 0xe0]),
  'photo.JPEG': bytes([0xff, 0xd8, 0xff, 0xe1]),
  'scan.png': bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'logo.gif': bytes('GIF89a'),
  'guests.csv': bytes('Name,Email\r\nAnn,ann@example.test'),
  'old.xls': compound,
  'budget.xlsx': zip,
};

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return error.issues[0].code;
  }
};

describe('a document', () => {
  it('is each format by its extension, whatever its case, kept under that format’s own type', () => {
    expect(
      Object.entries(heads).map(([name, head]) => checkDocument(name, head, documentFormats)),
    ).toEqual([
      { format: 'pdf', contentType: 'application/pdf' },
      { format: 'doc', contentType: 'application/msword' },
      {
        format: 'docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      { format: 'jpg', contentType: 'image/jpeg' },
      { format: 'jpg', contentType: 'image/jpeg' },
      { format: 'png', contentType: 'image/png' },
      { format: 'gif', contentType: 'image/gif' },
      { format: 'csv', contentType: 'text/csv' },
      { format: 'xls', contentType: 'application/vnd.ms-excel' },
      {
        format: 'xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ]);
  });

  it('is refused when its bytes are not its name’s format', () => {
    expect(codeOf(() => checkDocument('brief.pdf', zip, documentFormats))).toBe('type_mismatch');
    expect(codeOf(() => checkDocument('photo.png', bytes('GIF89a'), documentFormats))).toBe(
      'type_mismatch',
    );
    // A CSV is text: a NUL byte says it isn't.
    expect(codeOf(() => checkDocument('list.csv', bytes('a,b', [0], 'c'), documentFormats))).toBe(
      'type_mismatch',
    );
    expect(codeOf(() => checkDocument('brief.pdf', bytes('%PD'), documentFormats))).toBe(
      'type_mismatch',
    );
    // Markup is no table, whatever its name: a browser could read it as a page.
    for (const page of ['<html><body>', '  \r\n<svg onload=x>'])
      expect(codeOf(() => checkDocument('list.csv', bytes(page), documentFormats))).toBe(
        'type_mismatch',
      );
  });

  it('is refused when its name has no format the caller allows', () => {
    for (const name of ['page.html', 'drawing.svg', 'notes.txt', 'tool.exe', 'pdf', 'brief.pdf.'])
      expect(
        codeOf(() => checkDocument(name, bytes('%PDF-1.7'), documentFormats)),
        name,
      ).toBe('unsupported_type');
    expect(codeOf(() => checkDocument('brief.pdf', bytes('%PDF-1.7'), ['png', 'jpg']))).toBe(
      'unsupported_type',
    );
  });
});
