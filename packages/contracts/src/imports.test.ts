import { ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  endpoints,
  importEndpoints,
  importJob,
  importPlanInput,
  importTargetKey,
  inspectImportFileInput,
  listImportsQuery,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_TAGS,
  DEFAULT_IMPORT_MODE,
  importSorts,
  parseInput,
  previewImportInput,
} from './index.js';

const FILE = 'file_01h455vb4pex5vsknk084sn02q';
const FIELD = 'fld_01h455vb4pex5vsknk084sn02q';
const TAG = 'tag_01h455vb4pex5vsknk084sn02q';
const IMPORT = 'imp_01h455vb4pex5vsknk084sn02q';

const email = { kind: 'attribute', attribute: 'email' } as const;
const plan = {
  fileId: FILE,
  object: 'contact',
  mode: 'create',
  mapping: [{ column: 0, target: email }],
};

function issuesOf(work: () => unknown): { path: string; code: string }[] {
  try {
    work();
  } catch (error) {
    if (error instanceof ValidationError)
      return error.issues.map(({ path, code }) => ({ path, code }));
    throw error;
  }
  throw new Error('The input was accepted.');
}

describe('importPlanInput', () => {
  it('takes a file, what to import, what to do with existing contacts, and a mapping', () => {
    expect(parseInput(importPlanInput, plan)).toEqual({ ...plan, tagIds: [] });
    expect(
      parseInput(importPlanInput, {
        ...plan,
        mode: 'create_and_update',
        delimiter: ';',
        tagIds: [TAG],
        mapping: [
          { column: 3, target: email },
          { column: 0, target: { kind: 'field', fieldId: FIELD } },
        ],
      }),
    ).toMatchObject({ mode: 'create_and_update', delimiter: ';', tagIds: [TAG] });
  });

  it('adds new contacts only when no mode is named, and changes none that exist (B1.13)', () => {
    const { mode: _mode, ...withoutMode } = plan;
    expect(DEFAULT_IMPORT_MODE).toBe('create');
    expect(parseInput(importPlanInput, withoutMode)).toEqual({ ...plan, tagIds: [] });
    expect(parseInput(previewImportInput, withoutMode)).toMatchObject({ mode: 'create' });
    expect(issuesOf(() => parseInput(importPlanInput, { ...plan, mode: 'merge' }))).toEqual([
      { path: '/mode', code: 'invalid_value' },
    ]);
  });

  it('refuses a column mapped twice, and two columns filling the same thing', () => {
    expect(
      issuesOf(() =>
        parseInput(importPlanInput, {
          ...plan,
          mapping: [
            { column: 0, target: email },
            { column: 0, target: { kind: 'attribute', attribute: 'phone' } },
          ],
        }),
      ),
    ).toEqual([{ path: '/mapping/1/column', code: 'column_repeated' }]);
    expect(
      issuesOf(() =>
        parseInput(importPlanInput, {
          ...plan,
          mapping: [
            { column: 0, target: email },
            { column: 1, target: email },
            { column: 2, target: { kind: 'field', fieldId: FIELD } },
            { column: 3, target: { kind: 'field', fieldId: FIELD } },
          ],
        }),
      ),
    ).toEqual([
      { path: '/mapping/1/target', code: 'target_repeated' },
      { path: '/mapping/3/target', code: 'target_repeated' },
    ]);
  });

  it('refuses an empty mapping, a column outside any file, and anything it has no name for', () => {
    expect(issuesOf(() => parseInput(importPlanInput, { ...plan, mapping: [] }))).toEqual([
      { path: '/mapping', code: 'too_small' },
    ]);
    for (const column of [-1, MAX_IMPORT_COLUMNS, 1.5])
      expect(
        issuesOf(() =>
          parseInput(importPlanInput, { ...plan, mapping: [{ column, target: email }] }),
        ),
      ).toHaveLength(1);
    expect(
      issuesOf(() =>
        parseInput(importPlanInput, {
          ...plan,
          mapping: [{ column: 0, target: { kind: 'attribute', attribute: 'consent' } }],
        }),
      ),
    ).toEqual([{ path: '/mapping/0/target/attribute', code: 'invalid_value' }]);
    expect(issuesOf(() => parseInput(importPlanInput, { ...plan, consent: true }))).toEqual([
      { path: '/consent', code: 'unrecognized_keys' },
    ]);
    expect(issuesOf(() => parseInput(importPlanInput, { ...plan, object: 'deal' }))).toEqual([
      { path: '/object', code: 'invalid_value' },
    ]);
    expect(issuesOf(() => parseInput(importPlanInput, { ...plan, delimiter: ':' }))).toEqual([
      { path: '/delimiter', code: 'invalid_value' },
    ]);
  });

  it('takes each tag once, and a bounded number of them', () => {
    expect(issuesOf(() => parseInput(importPlanInput, { ...plan, tagIds: [TAG, TAG] }))).toEqual([
      { path: '/tagIds', code: 'custom' },
    ]);
    expect(
      issuesOf(() =>
        parseInput(importPlanInput, {
          ...plan,
          tagIds: Array.from({ length: MAX_IMPORT_TAGS + 1 }, () => TAG),
        }),
      ).map((issue) => issue.code),
    ).toContain('too_big');
    expect(issuesOf(() => parseInput(importPlanInput, { ...plan, tagIds: [FILE] }))).toEqual([
      { path: '/tagIds/0', code: 'invalid_format' },
    ]);
  });
});

describe('previewImportInput and inspectImportFileInput', () => {
  it('preview takes the plan as it is, and shows ten rows unless asked', () => {
    expect(parseInput(previewImportInput, plan)).toEqual({ ...plan, tagIds: [], rows: 10 });
    expect(parseInput(previewImportInput, { ...plan, rows: 50 }).rows).toBe(50);
    for (const rows of [0, 51])
      expect(issuesOf(() => parseInput(previewImportInput, { ...plan, rows }))).toHaveLength(1);
  });

  it('inspect takes a file and what it holds, and a delimiter only when the caller knows it', () => {
    expect(parseInput(inspectImportFileInput, { fileId: FILE, object: 'contact' })).toEqual({
      fileId: FILE,
      object: 'contact',
    });
    expect(
      parseInput(inspectImportFileInput, { fileId: FILE, object: 'contact', delimiter: '\t' })
        .delimiter,
    ).toBe('\t');
    expect(
      issuesOf(() => parseInput(inspectImportFileInput, { fileId: IMPORT, object: 'contact' })),
    ).toEqual([{ path: '/fileId', code: 'invalid_format' }]);
  });
});

describe('importTargetKey', () => {
  it('names an attribute and a field apart, and the same target the same way', () => {
    expect(importTargetKey(email)).toBe('attribute:email');
    expect(importTargetKey({ kind: 'field', fieldId: FIELD })).toBe(`field:${FIELD}`);
  });
});

describe('listImportsQuery', () => {
  it('reads a page size from the query string, twenty unless said', () => {
    expect(parseInput(listImportsQuery, {})).toEqual({
      limit: 20,
      sort: 'started',
      direction: 'desc',
    });
    expect(parseInput(listImportsQuery, { limit: '50', status: 'running' })).toEqual({
      limit: 50,
      status: 'running',
      sort: 'started',
      direction: 'desc',
    });
    for (const limit of ['0', '101', 'many'])
      expect(issuesOf(() => parseInput(listImportsQuery, { limit }))).toHaveLength(1);
  });

  it('filters by status, source, object and when it was started, and pages by import', () => {
    expect(
      parseInput(listImportsQuery, {
        status: 'completed',
        source: 'csv',
        object: 'contact',
        startedFrom: '2026-10-01T00:00:00Z',
        startedBefore: '2026-11-01T00:00:00Z',
        after: IMPORT,
      }),
    ).toMatchObject({ source: 'csv', object: 'contact', after: IMPORT });
    expect(issuesOf(() => parseInput(listImportsQuery, { status: 'draft' }))).toEqual([
      { path: '/status', code: 'invalid_value' },
    ]);
    expect(issuesOf(() => parseInput(listImportsQuery, { after: FILE }))).toEqual([
      { path: '/after', code: 'invalid_format' },
    ]);
    expect(issuesOf(() => parseInput(listImportsQuery, { order: 'status' }))).toEqual([
      { path: '/order', code: 'unrecognized_keys' },
    ]);
  });

  it('orders by any column of the history, newest first unless said (B1.13)', () => {
    expect(importSorts).toEqual([
      'started',
      'completed',
      'source',
      'importedBy',
      'status',
      'objects',
      'found',
      'errors',
    ]);
    for (const sort of importSorts)
      expect(parseInput(listImportsQuery, { sort, direction: 'asc' })).toMatchObject({
        sort,
        direction: 'asc',
      });
    expect(issuesOf(() => parseInput(listImportsQuery, { sort: 'fileName' }))).toEqual([
      { path: '/sort', code: 'invalid_value' },
    ]);
    expect(issuesOf(() => parseInput(listImportsQuery, { direction: 'down' }))).toEqual([
      { path: '/direction', code: 'invalid_value' },
    ]);
  });
});

describe('importJob', () => {
  it('shows an import with its counts, its mapping and who started it', () => {
    const shown = {
      id: IMPORT,
      source: 'csv',
      objects: ['contact'],
      status: 'completed',
      fileName: 'contacts.csv',
      mode: 'create',
      mapping: [{ column: 0, header: 'Email', target: email }],
      tagIds: [TAG],
      counts: { found: 3, processed: 3, created: 1, updated: 0, skipped: 1, failed: 1 },
      hasErrorFile: true,
      error: null,
      cancelRequested: false,
      startedBy: { kind: 'user', name: 'Dana Brooks', you: true },
      createdAt: '2026-10-10T09:00:00.000Z',
      startedAt: '2026-10-10T09:00:01.000Z',
      finishedAt: '2026-10-10T09:00:05.000Z',
      canCancel: false,
    };
    expect(importJob.parse(shown)).toEqual(shown);
    expect(importJob.safeParse({ ...shown, status: 'draft' }).success).toBe(false);
  });
});

describe('the import endpoints', () => {
  it('are all part of the public API, under /imports', () => {
    expect(importEndpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual([
      'post /imports/inspect',
      'post /imports/preview',
      'post /imports',
      'get /imports',
      'get /imports/{id}',
      'get /imports/{id}/rows',
      'post /imports/{id}/cancel',
      'post /imports/{id}/error-file-link',
    ]);
    for (const endpoint of importEndpoints) expect(endpoints).toContain(endpoint);
  });
});
