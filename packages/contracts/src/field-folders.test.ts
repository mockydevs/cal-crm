import { describe, expect, it } from 'vitest';

import {
  FIELD_FOLDER_LIMITS,
  createFieldFolderInput,
  customField,
  customFieldList,
  endpoints,
  fieldFolder,
  fieldFolderEndpoints,
  listCustomFieldsQuery,
  deleteFieldInput,
  fieldDeletion,
  fieldFolderList,
  folderFieldOrder,
  getMyPermissions,
  listFieldFoldersQuery,
  moveFieldsInput,
  myPermissions,
  parseInput,
  renameFieldFolderInput,
  reorderFieldFoldersInput,
  reorderFolderFieldsInput,
} from './index.js';

const folderId = 'ffld_01h455vb4pex5vsknk084sn02q';
const otherFolderId = 'ffld_01h455vb4pex5vsknk084sn02r';
const fieldId = 'fld_01h455vb4pex5vsknk084sn02q';
const revision = 'a'.repeat(64);

describe('a field folder’s inputs', () => {
  it('trim the name and keep it between 1 and 80 characters', () => {
    expect(
      parseInput(createFieldFolderInput, { objectKey: 'contact', name: '  Event details ' }),
    ).toEqual({ objectKey: 'contact', name: 'Event details' });
    for (const name of ['', '   ', 'x'.repeat(81)]) {
      expect(createFieldFolderInput.safeParse({ objectKey: 'contact', name }).success).toBe(false);
      expect(renameFieldFolderInput.safeParse({ name, revision }).success).toBe(false);
    }
    expect(
      createFieldFolderInput.safeParse({ objectKey: 'contact', name: 'x'.repeat(80) }).success,
    ).toBe(true);
  });

  it('refuse anything a folder cannot be given: a kind, a position, another object on rename', () => {
    expect(
      createFieldFolderInput.safeParse({ objectKey: 'contact', name: 'A', system: true }).success,
    ).toBe(false);
    expect(createFieldFolderInput.safeParse({ objectKey: 'Contact', name: 'A' }).success).toBe(
      false,
    );
    expect(renameFieldFolderInput.safeParse({ name: 'A' }).success).toBe(false);
    expect(renameFieldFolderInput.safeParse({ name: 'A', revision: 'stale' }).success).toBe(false);
    expect(
      renameFieldFolderInput.safeParse({ name: 'A', revision, objectKey: 'deal' }).success,
    ).toBe(false);
  });

  it('take an order as every folder named once', () => {
    expect(
      parseInput(reorderFieldFoldersInput, {
        objectKey: 'contact',
        folderIds: [otherFolderId, folderId],
      }).folderIds,
    ).toEqual([otherFolderId, folderId]);
    for (const folderIds of [
      [],
      [folderId, folderId],
      [fieldId],
      Array.from({ length: FIELD_FOLDER_LIMITS.perObject + 1 }, () => folderId),
    ])
      expect(reorderFieldFoldersInput.safeParse({ objectKey: 'contact', folderIds }).success).toBe(
        false,
      );
  });

  it('take between 1 and 100 different fields to move', () => {
    expect(parseInput(moveFieldsInput, { fieldIds: [fieldId] })).toEqual({ fieldIds: [fieldId] });
    for (const fieldIds of [[], [fieldId, fieldId], [folderId]])
      expect(moveFieldsInput.safeParse({ fieldIds }).success).toBe(false);
    expect(moveFieldsInput.safeParse({ fieldIds: [fieldId], folderId }).success).toBe(false);
  });
});

describe('the field list’s query', () => {
  it('defaults to live fields, newest first, 20 to a page', () => {
    expect(parseInput(listCustomFieldsQuery, {})).toEqual({
      archived: 'exclude',
      sort: 'created_desc',
      limit: 20,
    });
  });

  it('reads every filter from a query string', () => {
    expect(
      parseInput(listCustomFieldsQuery, {
        objectKey: 'deal',
        valueType: 'single_choice',
        folderId,
        source: 'import',
        createdFrom: '2026-10-01T00:00:00+03:00',
        createdBefore: '2026-11-01T00:00:00Z',
        q: '  fence ',
        archived: 'include',
        sort: 'created_asc',
        limit: '50',
        after: fieldId,
      }),
    ).toEqual({
      objectKey: 'deal',
      valueType: 'single_choice',
      folderId,
      source: 'import',
      createdFrom: '2026-10-01T00:00:00+03:00',
      createdBefore: '2026-11-01T00:00:00Z',
      q: 'fence',
      archived: 'include',
      sort: 'created_asc',
      limit: 50,
      after: fieldId,
    });
  });

  it.each([
    { valueType: 'signature' },
    { source: 'robot' },
    { createdFrom: '2026-10-01' },
    { limit: '0' },
    { limit: String(FIELD_FOLDER_LIMITS.page + 1) },
    { limit: '2.5' },
    { after: folderId },
    { folderId: fieldId },
    { sort: 'name' },
    { archived: 'yes' },
    { q: 'x'.repeat(201) },
    { page: '2' },
  ])('refuses %j', (query) => {
    expect(listCustomFieldsQuery.safeParse(query).success).toBe(false);
  });
});

describe('what the page is answered with', () => {
  const folder = {
    id: folderId,
    objectKey: 'contact',
    name: 'Additional Info',
    system: true,
    position: 0,
    fieldCount: 2,
    createdAt: '2026-10-10T09:30:00.000Z',
    revision,
  };
  const field = {
    id: fieldId,
    objectKey: 'contact',
    key: 'select_your_fence_type',
    label: 'Select your fence type',
    description: 'The fence they asked about.',
    valueType: 'single_choice',
    currency: null,
    options: [{ key: 'wood', label: 'Wood', description: '', archived: false }],
    aiFillSources: [],
    aiOverwrite: 'ask',
    archived: false,
    revision,
    folderId,
    folderName: 'Additional Info',
    placeholder: '',
    mergeKey: 'contact.select_your_fence_type',
    createdAt: '2026-10-10T09:30:00.000Z',
    source: 'user',
  };

  it('is a folder with its count, and a field with its folder, key and origin', () => {
    expect(fieldFolder.parse(folder)).toEqual(folder);
    expect(customField.parse(field)).toEqual(field);
    expect(
      customFieldList.parse({
        items: [field],
        total: 1,
        next: null,
        objects: [{ key: 'contact', label: 'Contact', fields: 1, folders: 1 }],
        canManage: true,
      }).items,
    ).toEqual([field]);
  });

  it.each(['folderId', 'folderName', 'placeholder', 'mergeKey', 'createdAt', 'source'])(
    'always has a field’s %s in the list',
    (property) => {
      const { [property]: _left, ...rest } = field as Record<string, unknown>;
      expect(customField.safeParse(rest).success).toBe(false);
    },
  );
});

describe('the endpoints', () => {
  it('are all part of the API, each with its own operation and path', () => {
    for (const endpoint of fieldFolderEndpoints) expect(endpoints).toContain(endpoint);
    expect(fieldFolderEndpoints.map((each) => `${each.method} ${each.path}`)).toEqual([
      'get /custom-fields',
      'get /field-folders',
      'post /field-folders',
      'put /field-folders/order',
      'put /field-folders/{folderId}',
      'delete /field-folders/{folderId}',
      'post /field-folders/{folderId}/fields',
      'put /field-folders/{folderId}/fields/order',
    ]);
    const operations = endpoints.map((each) => each.operationId);
    expect(new Set(operations).size).toBe(operations.length);
  });
});

describe('the order of a folder’s fields', () => {
  it('is every field named once, up to the limit', () => {
    expect(parseInput(reorderFolderFieldsInput, { fieldIds: [fieldId] })).toEqual({
      fieldIds: [fieldId],
    });
    for (const input of [
      { fieldIds: [] },
      { fieldIds: [fieldId, fieldId] },
      { fieldIds: [folderId] },
      { fieldIds: [fieldId], folderId },
      { fieldIds: Array.from({ length: FIELD_FOLDER_LIMITS.order + 1 }, () => fieldId) },
    ])
      expect(reorderFolderFieldsInput.safeParse(input).success).toBe(false);
    expect(
      folderFieldOrder.safeParse({
        folder: {
          id: folderId,
          objectKey: 'contact',
          name: 'Quote',
          system: false,
          position: 1,
          fieldCount: 1,
          createdAt: '2026-10-11T07:00:00.000Z',
          revision,
        },
        fieldIds: [fieldId],
      }).success,
    ).toBe(true);
  });
});

describe('the folder list’s query', () => {
  it('asks for everything unless a limit is given, and reads each filter from a query string', () => {
    expect(parseInput(listFieldFoldersQuery, {})).toEqual({});
    expect(
      parseInput(listFieldFoldersQuery, {
        objectKey: 'contact',
        q: '  quote ',
        createdFrom: '2026-10-01T00:00:00Z',
        createdBefore: '2026-11-01T00:00:00Z',
        limit: '20',
        after: folderId,
      }),
    ).toEqual({
      objectKey: 'contact',
      q: 'quote',
      createdFrom: '2026-10-01T00:00:00Z',
      createdBefore: '2026-11-01T00:00:00Z',
      limit: 20,
      after: folderId,
    });
    for (const query of [
      { limit: '0' },
      { limit: String(FIELD_FOLDER_LIMITS.page + 1) },
      { limit: '2.5' },
      { after: fieldId },
      { createdFrom: '2026-10-01' },
      { q: 'x'.repeat(201) },
      { page: '2' },
    ])
      expect(listFieldFoldersQuery.safeParse(query).success).toBe(false);
  });

  it('is answered with or without the count and the next page, as an older answer was', () => {
    expect(fieldFolderList.safeParse({ items: [], canManage: false }).success).toBe(true);
    expect(
      fieldFolderList.safeParse({ items: [], canManage: true, total: 0, next: null }).success,
    ).toBe(true);
    expect(
      fieldFolderList.safeParse({ items: [], canManage: true, total: 3, next: fieldId }).success,
    ).toBe(false);
  });
});

describe('a field’s deletion', () => {
  const deletion = {
    field: { id: fieldId, objectKey: 'contact', key: 'fence_type', label: 'Fence', mergeKey: null },
    values: 2,
    templates: [{ id: 'tmpl_01h455vb4pex5vsknk084sn02q', name: 'Quote' }],
    automations: [{ id: 'aut_01h455vb4pex5vsknk084sn02q', name: 'Follow up' }],
    canDelete: true,
    confirmation: revision,
  };
  it('names the field, what it would lose, and a confirmation to send back', () => {
    expect(fieldDeletion.parse(deletion)).toEqual(deletion);
    for (const change of [
      { values: -1 },
      { confirmation: 'short' },
      { templates: [{ id: fieldId, name: 'Quote' }] },
      { automations: [{ id: fieldId, name: 'Follow up' }] },
    ])
      expect(fieldDeletion.safeParse({ ...deletion, ...change }).success).toBe(false);
  });
  it('is confirmed by exactly that token and nothing else', () => {
    expect(parseInput(deleteFieldInput, { confirmation: revision })).toEqual({
      confirmation: revision,
    });
    for (const input of [{}, { confirmation: 'yes' }, { confirmation: revision, force: true }])
      expect(deleteFieldInput.safeParse(input).success).toBe(false);
  });
});

describe('what the caller may change', () => {
  it('is a list of permissions the catalog has, in a business or at the agency', () => {
    expect(endpoints).toContain(getMyPermissions);
    expect(`${getMyPermissions.method} ${getMyPermissions.path}`).toBe('get /me/permissions');
    expect(
      myPermissions.safeParse({ business: null, permissions: ['fields.manage', 'trash.purge'] })
        .success,
    ).toBe(true);
    expect(myPermissions.safeParse({ business: null, permissions: ['fields.fly'] }).success).toBe(
      false,
    );
    expect(myPermissions.safeParse({ business: fieldId, permissions: [] }).success).toBe(false);
  });
});
