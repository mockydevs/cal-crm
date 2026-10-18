import { describe, expect, it } from 'vitest';

import {
  createFieldInput,
  documentFormatOf,
  listRecordFilesQuery,
  recordField,
  updateFieldInput,
} from './index.js';

const base = {
  objectKey: 'contact',
  key: 'contract',
  label: 'Contract',
  description: 'The signed contract.',
  options: [],
  currency: null,
  aiFillSources: [],
  aiOverwrite: 'ask',
  archived: false,
};
const box = { key: 'first', label: 'First', description: '', archived: false };

describe("a document's format", () => {
  it('is its extension, jpeg as jpg, whatever the case; any other name has none', () => {
    expect(
      ['a.PDF', 'b.jpeg', 'c.Jpg', 'd.docx', 'e.xlsx', 'f.csv', 'g.txt', 'pdf', 'h.pdf.'].map(
        documentFormatOf,
      ),
    ).toEqual(['pdf', 'jpg', 'jpg', 'docx', 'xlsx', 'csv', undefined, undefined, undefined]);
  });
});

describe('a file upload field', () => {
  it('is made with its formats and a limit from 1 to 10, each format once', () => {
    const file = { ...base, valueType: 'file' };
    expect(
      createFieldInput.safeParse({ ...file, files: { formats: ['pdf', 'png'], limit: 2 } }).success,
    ).toBe(true);
    for (const files of [
      undefined,
      { formats: [], limit: 1 },
      { formats: ['pdf', 'pdf'], limit: 1 },
      { formats: ['exe'], limit: 1 },
      { formats: ['pdf'], limit: 0 },
      { formats: ['pdf'], limit: 11 },
    ])
      expect(createFieldInput.safeParse({ ...file, files }).success, JSON.stringify(files)).toBe(
        false,
      );
    expect(
      createFieldInput.safeParse({
        ...base,
        valueType: 'text',
        files: { formats: ['pdf'], limit: 1 },
      }).success,
    ).toBe(false);
    expect(
      createFieldInput.safeParse({
        ...file,
        files: { formats: ['pdf'], limit: 1 },
        aiFillSources: ['forms'],
      }).success,
    ).toBe(false);
  });
  it('can be saved with new formats and limit, or without them', () => {
    const save = {
      label: 'Contract',
      description: 'The signed contract.',
      options: [],
      aiFillSources: [],
      aiOverwrite: 'ask',
      archived: false,
      revision: 'a'.repeat(64),
    };
    expect(updateFieldInput.safeParse(save).success).toBe(true);
    expect(
      updateFieldInput.safeParse({ ...save, files: { formats: ['csv'], limit: 3 } }).success,
    ).toBe(true);
  });
});

describe('a text box list field', () => {
  it('needs a box, and no AI source', () => {
    const list = { ...base, valueType: 'text_list' };
    expect(createFieldInput.safeParse({ ...list, options: [box] }).success).toBe(true);
    expect(createFieldInput.safeParse(list).success).toBe(false);
    expect(
      createFieldInput.safeParse({ ...list, options: [box], aiFillSources: ['conversations'] })
        .success,
    ).toBe(false);
  });
});

describe('a record field of the new types', () => {
  const definition = {
    id: 'fld_01h455vb4pex5vsknk084sn02q',
    objectKey: 'contact',
    key: 'refs',
    label: 'Refs',
    description: 'People to ask about them.',
    options: [box],
    aiFillSources: [],
    aiOverwrite: 'ask',
    archived: false,
    currency: null,
    revision: 'r',
  };
  const saved = {
    source: { kind: 'user', eventId: null, you: true },
    updatedAt: '2026-10-17T10:00:00.000Z',
    confidence: null,
    confirmedAt: null,
    revision: 'a'.repeat(64),
  };
  it("holds a text box list's text by box, and a file field's file ids", () => {
    expect(
      recordField.safeParse({
        ...saved,
        definition: { ...definition, valueType: 'text_list' },
        value: { first: 'Ann' },
      }).success,
    ).toBe(true);
    expect(
      recordField.safeParse({
        ...saved,
        definition: { ...definition, valueType: 'file', options: [] },
        value: ['file_01h455vb4pex5vsknk084sn02q'],
      }).success,
    ).toBe(true);
    expect(
      recordField.safeParse({
        ...saved,
        definition: { ...definition, valueType: 'file', options: [] },
        value: ['not-a-file'],
      }).success,
    ).toBe(false);
  });
});

describe("a record's files list", () => {
  it('is every folder, fifty at a time, unless asked otherwise', () => {
    expect(listRecordFilesQuery.parse({})).toEqual({ folder: 'all', limit: 50 });
    expect(listRecordFilesQuery.safeParse({ folder: 'trash' }).success).toBe(false);
    expect(listRecordFilesQuery.safeParse({ limit: '101' }).success).toBe(false);
  });
});
