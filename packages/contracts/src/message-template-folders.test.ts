import { describe, expect, it } from 'vitest';
import {
  createMessageTemplate,
  listMessageTemplates,
  updateMessageTemplateInput,
} from './message-templates.js';

import {
  createMessageTemplateFolderInput,
  messageTemplateFolderList,
  messageTemplateFolderRevisionInput,
  moveMessageTemplateInput,
  updateMessageTemplateFolderInput,
} from './message-template-folders.js';

const folder = 'tfld_01h455vb4pex5vsknk084sn02q';
const revision = 'a'.repeat(64);

it('allows folder placement only on creation, keeping content edits separate from moves', () => {
  const content = { name: 'Guide', subject: 'Hello', body: 'Welcome.' };
  expect(createMessageTemplate.body.parse({ ...content, folderId: folder })).toEqual({
    ...content,
    folderId: folder,
  });
  expect(createMessageTemplate.body.parse({ ...content, folderId: null })).toEqual({
    ...content,
    folderId: null,
  });
  expect(createMessageTemplate.body.parse(content)).toEqual(content);
  expect(
    createMessageTemplate.body.safeParse({
      ...content,
      folderId: 'tmpl_01h455vb4pex5vsknk084sn02q',
    }).success,
  ).toBe(false);
  expect(
    updateMessageTemplateInput.safeParse({ ...content, revision, folderId: folder }).success,
  ).toBe(false);
});

it('distinguishes whole-library search from explicit root and nested folder search', () => {
  const defaults = { archived: 'exclude', deleted: 'exclude', sort: 'name' };
  expect(listMessageTemplates.query.parse({})).toEqual(defaults);
  expect(listMessageTemplates.query.parse({ folder: 'root', q: '  guide  ' })).toEqual({
    ...defaults,
    folder: 'root',
    q: 'guide',
  });
  expect(listMessageTemplates.query.parse({ folder })).toEqual({ ...defaults, folder });
  expect(listMessageTemplates.query.safeParse({ folder: null }).success).toBe(false);
  expect(
    listMessageTemplates.query.safeParse({ folder: 'tmpl_01h455vb4pex5vsknk084sn02q' }).success,
  ).toBe(false);
  expect(listMessageTemplates.query.safeParse({ q: 'x'.repeat(121) }).success).toBe(false);
});

it('lists the folders with what the panel counts: live, unfiled, archived and in the trash', () => {
  const counts = { all: 12, unfiled: 3, archived: 2, deleted: 1 };
  expect(messageTemplateFolderList.parse({ canManage: true, items: [], counts })).toEqual({
    canManage: true,
    items: [],
    counts,
  });
  // Optional, so an older server's answer still reads.
  expect(messageTemplateFolderList.parse({ canManage: true, items: [] })).toEqual({
    canManage: true,
    items: [],
  });
  for (const wrong of [
    { ...counts, all: -1 },
    { ...counts, deleted: 1.5 },
    { all: 1, unfiled: 0, archived: 0 },
  ])
    expect(
      messageTemplateFolderList.safeParse({ canManage: true, items: [], counts: wrong }).success,
      JSON.stringify(wrong),
    ).toBe(false);
});

describe('message template folder authoring inputs', () => {
  it('creates at root when the parent is omitted, trimming the display name', () => {
    expect(createMessageTemplateFolderInput.parse({ name: '  Welcome  ' })).toEqual({
      name: 'Welcome',
      parentId: null,
    });
    expect(createMessageTemplateFolderInput.parse({ name: 'Welcome', parentId: folder })).toEqual({
      name: 'Welcome',
      parentId: folder,
    });
  });

  it.each(['', ' \t ', 'x'.repeat(121)])('rejects unusable folder names', (name) => {
    expect(createMessageTemplateFolderInput.safeParse({ name }).success).toBe(false);
  });

  it('accepts the largest name and refuses mass-assigned tenant fields', () => {
    expect(createMessageTemplateFolderInput.parse({ name: 'x'.repeat(120) }).name).toBe(
      'x'.repeat(120),
    );
    expect(
      createMessageTemplateFolderInput.safeParse({ name: 'Welcome', businessId: 'other' }).success,
    ).toBe(false);
  });

  it.each(['tmpl_01h455vb4pex5vsknk084sn02q', 'afol_01h455vb4pex5vsknk084sn02q', 'tfld_invalid'])(
    'rejects other record kinds and malformed parents',
    (parentId) => {
      expect(
        createMessageTemplateFolderInput.safeParse({ name: 'Welcome', parentId }).success,
      ).toBe(false);
    },
  );

  it('distinguishes an omitted parent from a requested move to root', () => {
    expect(updateMessageTemplateFolderInput.parse({ revision: 1, name: 'New name' })).toEqual({
      revision: 1,
      name: 'New name',
    });
    expect(updateMessageTemplateFolderInput.parse({ revision: 2, parentId: null })).toEqual({
      revision: 2,
      parentId: null,
    });
    expect(updateMessageTemplateFolderInput.parse({ revision: 2, parentId: folder })).toEqual({
      revision: 2,
      parentId: folder,
    });
    expect(updateMessageTemplateFolderInput.safeParse({ revision: 1 }).success).toBe(false);
  });

  it.each([0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])(
    'requires a positive safe integer folder revision',
    (revision) => {
      expect(
        updateMessageTemplateFolderInput.safeParse({ revision, name: 'Changed' }).success,
      ).toBe(false);
      expect(messageTemplateFolderRevisionInput.safeParse({ revision }).success).toBe(false);
    },
  );

  it('requires the template content revision and an explicit destination when moving an asset', () => {
    expect(moveMessageTemplateInput.parse({ revision, folderId: null })).toEqual({
      revision,
      folderId: null,
    });
    expect(moveMessageTemplateInput.parse({ revision, folderId: folder })).toEqual({
      revision,
      folderId: folder,
    });
    expect(moveMessageTemplateInput.safeParse({ revision }).success).toBe(false);
    expect(
      moveMessageTemplateInput.safeParse({ revision: 'A'.repeat(64), folderId: null }).success,
    ).toBe(false);
    expect(
      moveMessageTemplateInput.safeParse({ revision, folderId: folder, body: 'overwrite' }).success,
    ).toBe(false);
  });
});
