import type { ImportFileInspection } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  choicesOf,
  csvUpload,
  isCsvName,
  mappingOf,
  progressOf,
  targetOf,
  takenBy,
} from './import-rules';

const fieldId = 'fld_01h455vb4pex5vsknk084sn02q';
const inspection: ImportFileInspection = {
  file: { id: 'file_01h455vb4pex5vsknk084sn02q', filename: 'contacts.csv', size: 120 },
  delimiter: ',',
  columns: [
    { index: 0, header: 'First name', samples: ['Maya'] },
    { index: 1, header: 'Email', samples: ['maya@example.com'] },
    { index: 2, header: 'Shoe size', samples: ['38'] },
    { index: 3, header: 'Event date', samples: ['2026-11-02'] },
  ],
  rowCount: 3,
  suggestedMapping: [
    { column: 0, target: { kind: 'attribute', attribute: 'firstName' } },
    { column: 1, target: { kind: 'attribute', attribute: 'email' } },
    { column: 3, target: { kind: 'field', fieldId } },
  ],
  attributes: ['firstName', 'lastName', 'email', 'phone'],
  fields: [{ id: fieldId, key: 'event_date', label: 'Event date', valueType: 'date' }],
  limits: { rows: 100_000, columns: 200, previewRows: 50, tags: 20 },
};

describe('mapping the columns of a file', () => {
  it('starts from what the server suggests, and leaves the rest out', () => {
    expect(choicesOf(inspection)).toEqual([
      'attribute:firstName',
      'attribute:email',
      '',
      `field:${fieldId}`,
    ]);
  });

  it('reads a choice back as the target it names, if the file can fill it', () => {
    expect(targetOf('attribute:email', inspection)).toEqual({
      kind: 'attribute',
      attribute: 'email',
    });
    expect(targetOf(`field:${fieldId}`, inspection)).toEqual({ kind: 'field', fieldId });
    expect(targetOf('', inspection)).toBeUndefined();
    expect(targetOf('attribute:tags', inspection)).toBeUndefined();
    expect(targetOf('field:fld_01h455vb4pex5vsknk084sn999', inspection)).toBeUndefined();
  });

  it('sends only the columns that fill something', () => {
    expect(mappingOf(['attribute:firstName', '', '', `field:${fieldId}`], inspection)).toEqual([
      { column: 0, target: { kind: 'attribute', attribute: 'firstName' } },
      { column: 3, target: { kind: 'field', fieldId } },
    ]);
    expect(mappingOf(['', '', '', ''], inspection)).toEqual([]);
  });

  it('knows which column already fills a target, so no other can', () => {
    const choices = ['attribute:firstName', 'attribute:email', '', ''];
    expect(takenBy(choices, 'attribute:email', 2)).toBe(true);
    expect(takenBy(choices, 'attribute:email', 1)).toBe(false);
    expect(takenBy(choices, 'attribute:phone', 2)).toBe(false);
  });
});

describe('an import as it runs', () => {
  it('says how far it has got as a whole percentage', () => {
    expect(progressOf({ found: 200, processed: 50 })).toBe(25);
    expect(progressOf({ found: 3, processed: 1 })).toBe(33);
    expect(progressOf({ found: 3, processed: 3 })).toBe(100);
  });

  it('has got nowhere before the rows are counted', () => {
    expect(progressOf({ found: 0, processed: 0 })).toBe(0);
  });
});

describe('the file to upload', () => {
  it('is a CSV file by its name', () => {
    expect(isCsvName('contacts.csv')).toBe(true);
    expect(isCsvName('CONTACTS.CSV')).toBe(true);
    expect(isCsvName('contacts.xlsx')).toBe(false);
    expect(isCsvName('csv')).toBe(false);
  });

  it('is sent as text/csv, whatever the browser calls it', () => {
    const file = new File(['Email\nmaya@example.com\n'], 'contacts.csv', {
      type: 'application/vnd.ms-excel',
    });
    const upload = csvUpload(file);
    expect(upload.type).toBe('text/csv');
    expect(upload.content).toBe(file);
  });
});
