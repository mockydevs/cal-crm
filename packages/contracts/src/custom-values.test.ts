import { describe, expect, it } from 'vitest';

import {
  CUSTOM_VALUE_LIMITS,
  createCustomValueFolderInput,
  createCustomValueInput,
  customValue,
  customValueEndpoints,
  customValueFolder,
  customValueFolderList,
  customValueList,
  deleteCustomValuesInput,
  listCustomValueFoldersQuery,
  endpoints,
  listCustomValuesQuery,
  moveCustomValuesInput,
  parseInput,
  renameCustomValueFolderInput,
  updateCustomValueInput,
} from './index.js';

const valueId = 'cval_01h455vb4pex5vsknk084sn02q';
const folderId = 'cvf_01h455vb4pex5vsknk084sn02q';
const revision = 'a'.repeat(64);

describe('a custom value’s inputs', () => {
  it('need only a name: the text is empty, there is no folder and the server makes the key', () => {
    expect(parseInput(createCustomValueInput, { name: '  Hours of operation ' })).toEqual({
      name: 'Hours of operation',
      value: '',
      folderId: null,
    });
  });

  it('keep the text exactly as written, up to 5,000 characters', () => {
    const value = '  Mon to Fri\n9 to 5  ';
    expect(parseInput(createCustomValueInput, { name: 'Hours', value }).value).toBe(value);
    expect(
      createCustomValueInput.safeParse({
        name: 'Hours',
        value: 'x'.repeat(CUSTOM_VALUE_LIMITS.value),
      }).success,
    ).toBe(true);
    expect(
      createCustomValueInput.safeParse({
        name: 'Hours',
        value: 'x'.repeat(CUSTOM_VALUE_LIMITS.value + 1),
      }).success,
    ).toBe(false);
  });

  it('take a key only when it is created, and only a well-formed one', () => {
    expect(parseInput(createCustomValueInput, { name: 'Hours', key: 'opening_hours' }).key).toBe(
      'opening_hours',
    );
    for (const key of ['Opening', '1st', 'a b', 'a-b', '', `a${'b'.repeat(63)}`])
      expect(createCustomValueInput.safeParse({ name: 'Hours', key }).success).toBe(false);
    const edit = { name: 'Hours', value: '9 to 5', folderId: null, revision };
    expect(parseInput(updateCustomValueInput, edit)).toEqual(edit);
    expect(updateCustomValueInput.safeParse({ ...edit, key: 'opening_hours' }).success).toBe(false);
  });

  it.each([
    { name: '' },
    { name: '   ' },
    { name: 'x'.repeat(121) },
    { name: 'Hours', folderId: valueId },
    { name: 'Hours', value: null },
    { name: 'Hours', mergeKey: 'custom_values.hours' },
  ])('refuse %j', (input) => {
    expect(createCustomValueInput.safeParse(input).success).toBe(false);
  });

  it('save the whole value under the revision it was read at', () => {
    const edit = { name: 'Hours', value: '', folderId, revision };
    expect(parseInput(updateCustomValueInput, edit)).toEqual(edit);
    for (const missing of ['name', 'value', 'folderId', 'revision']) {
      const { [missing]: _left, ...rest } = edit as Record<string, unknown>;
      expect(updateCustomValueInput.safeParse(rest).success).toBe(false);
    }
    expect(updateCustomValueInput.safeParse({ ...edit, revision: 'stale' }).success).toBe(false);
  });

  it('move between 1 and 100 different values, to a folder or out of any', () => {
    expect(parseInput(moveCustomValuesInput, { valueIds: [valueId], folderId })).toEqual({
      valueIds: [valueId],
      folderId,
    });
    expect(
      parseInput(moveCustomValuesInput, { valueIds: [valueId], folderId: null }).folderId,
    ).toBeNull();
    for (const input of [
      { valueIds: [], folderId },
      { valueIds: [valueId, valueId], folderId },
      { valueIds: [folderId], folderId },
      { valueIds: [valueId] },
      {
        valueIds: Array.from({ length: CUSTOM_VALUE_LIMITS.move + 1 }, () => valueId),
        folderId,
      },
    ])
      expect(moveCustomValuesInput.safeParse(input).success).toBe(false);
  });

  it('name a folder with 1 to 80 characters, trimmed', () => {
    expect(parseInput(createCustomValueFolderInput, { name: ' Links ' })).toEqual({
      name: 'Links',
    });
    expect(parseInput(renameCustomValueFolderInput, { name: 'Links', revision })).toEqual({
      name: 'Links',
      revision,
    });
    for (const name of ['', '  ', 'x'.repeat(81)]) {
      expect(createCustomValueFolderInput.safeParse({ name }).success).toBe(false);
      expect(renameCustomValueFolderInput.safeParse({ name, revision }).success).toBe(false);
    }
    expect(renameCustomValueFolderInput.safeParse({ name: 'Links' }).success).toBe(false);
  });
});

describe('the list’s query', () => {
  it('defaults to every value, 20 to a page', () => {
    expect(parseInput(listCustomValuesQuery, {})).toEqual({ limit: 20 });
  });

  it('reads a search, a folder or "none", a page size and where to go on from', () => {
    expect(
      parseInput(listCustomValuesQuery, {
        q: ' hours ',
        folder: folderId,
        limit: '100',
        after: 'x',
      }),
    ).toEqual({ q: 'hours', folder: folderId, limit: 100, after: 'x' });
    expect(parseInput(listCustomValuesQuery, { folder: 'none' }).folder).toBe('none');
  });

  it.each([
    { folder: 'all' },
    { folder: valueId },
    { limit: '0' },
    { limit: String(CUSTOM_VALUE_LIMITS.page + 1) },
    { q: 'x'.repeat(201) },
    { after: 'x'.repeat(601) },
    { folderId },
  ])('refuses %j', (query) => {
    expect(listCustomValuesQuery.safeParse(query).success).toBe(false);
  });
});

describe('what the page is answered with', () => {
  const value = {
    id: valueId,
    key: 'hours_of_operation',
    mergeKey: 'custom_values.hours_of_operation',
    name: 'Hours of operation',
    value: 'Mon to Fri, 9 to 5',
    folderId: null,
    folderName: null,
    createdAt: '2026-10-10T09:30:00.000Z',
    updatedAt: '2026-10-10T09:30:00.000Z',
    revision,
  };

  it('is a value with its key, merge key and folder, and a folder with its count', () => {
    expect(customValue.parse(value)).toEqual(value);
    expect(
      customValueList.parse({ items: [value], total: 1, next: null, canManage: false }).items,
    ).toEqual([value]);
    const folder = {
      id: folderId,
      name: 'Links',
      valueCount: 3,
      createdAt: '2026-10-10T09:30:00.000Z',
      revision,
    };
    expect(customValueFolder.parse(folder)).toEqual(folder);
  });
});

describe('the endpoints', () => {
  it('are all part of the API, each with its own method and path', () => {
    for (const endpoint of customValueEndpoints) expect(endpoints).toContain(endpoint);
    expect(customValueEndpoints.map((each) => `${each.method} ${each.path}`)).toEqual([
      'get /custom-values',
      'post /custom-values',
      'post /custom-values/move',
      'post /custom-values/delete',
      'get /custom-values/{valueId}',
      'put /custom-values/{valueId}',
      'delete /custom-values/{valueId}',
      'get /custom-value-folders',
      'post /custom-value-folders',
      'put /custom-value-folders/{folderId}',
      'delete /custom-value-folders/{folderId}',
    ]);
  });
});

describe('deleting several values, and the folder list’s query', () => {
  it('takes between 1 and 100 different values and nothing else', () => {
    expect(parseInput(deleteCustomValuesInput, { valueIds: [valueId] })).toEqual({
      valueIds: [valueId],
    });
    for (const input of [
      { valueIds: [] },
      { valueIds: [valueId, valueId] },
      { valueIds: ['fld_01h455vb4pex5vsknk084sn02q'] },
      { valueIds: [valueId], folderId: null },
      { valueIds: Array.from({ length: CUSTOM_VALUE_LIMITS.move + 1 }, () => valueId) },
    ])
      expect(deleteCustomValuesInput.safeParse(input).success).toBe(false);
  });

  it('asks for every folder unless a limit is given, and reads each filter from a query string', () => {
    expect(parseInput(listCustomValueFoldersQuery, {})).toEqual({});
    expect(
      parseInput(listCustomValueFoldersQuery, {
        q: ' hours ',
        createdFrom: '2026-10-01T00:00:00Z',
        createdBefore: '2026-11-01T00:00:00Z',
        limit: '20',
        after: 'WyJhIiwiYiJd',
      }),
    ).toEqual({
      q: 'hours',
      createdFrom: '2026-10-01T00:00:00Z',
      createdBefore: '2026-11-01T00:00:00Z',
      limit: 20,
      after: 'WyJhIiwiYiJd',
    });
    for (const query of [
      { limit: '0' },
      { limit: String(CUSTOM_VALUE_LIMITS.page + 1) },
      { after: '' },
      { createdBefore: 'yesterday' },
      { folder: 'none' },
    ])
      expect(listCustomValueFoldersQuery.safeParse(query).success).toBe(false);
    expect(customValueFolderList.safeParse({ items: [], canManage: false }).success).toBe(true);
    expect(
      customValueFolderList.safeParse({ items: [], canManage: false, total: 0, next: null })
        .success,
    ).toBe(true);
  });
});
