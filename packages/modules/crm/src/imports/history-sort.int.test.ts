// Against a migrated Postgres: the history of imports in the order of any of its
// columns, paged without losing its place, and the mode an import has when it names none.
import { allowEveryone, type Services } from '@repo/commands';
import {
  DEFAULT_IMPORT_MODE,
  importJob,
  importList,
  importPreview,
  importSorts,
  type ImportSort,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { toPublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  attribute,
  importApi,
  memoryFiles,
  uploadCsv,
  workspace,
  type Workspace,
} from '../../test/imports.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let files: ReturnType<typeof memoryFiles>;
let api: ReturnType<typeof importApi>;
// What the server's reader of people's names answers, for the people a test names.
const people = new Map<string, string>();

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  files = memoryFiles(db);
  api = importApi(services, files, {
    actorNames: {
      user: (_trx, ids) =>
        Promise.resolve(
          new Map(
            ids.flatMap((id) => {
              const name = people.get(id);
              return name === undefined ? [] : [[id, name] as const];
            }),
          ),
        ),
    },
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

interface Stored {
  readonly name: string;
  readonly source: 'csv' | 'ghl';
  readonly status: 'pending' | 'completed' | 'failed' | 'cancelled';
  readonly objects: readonly string[];
  readonly found: number;
  readonly errors: number;
  /** Days before a fixed moment that it was started, and finished. */
  readonly started: number;
  readonly finished: number | null;
  readonly by: string | null;
}

// Six imports whose every column orders them differently, with ties in each column. One
// is still waiting: a business has at most one import that has not ended.
const HISTORY: readonly Stored[] = [
  {
    name: 'a',
    source: 'csv',
    status: 'completed',
    objects: ['contact'],
    found: 50,
    errors: 0,
    started: 6,
    finished: 5,
    by: 'Zoe',
  },
  {
    name: 'b',
    source: 'ghl',
    status: 'completed',
    objects: ['contact', 'deal'],
    found: 10,
    errors: 3,
    started: 5,
    finished: 1,
    by: null,
  },
  {
    name: 'c',
    source: 'csv',
    status: 'failed',
    objects: ['company'],
    found: 50,
    errors: 0,
    started: 4,
    finished: 4,
    by: 'adam',
  },
  {
    name: 'd',
    source: 'csv',
    status: 'cancelled',
    objects: ['contact'],
    found: 5,
    errors: 3,
    started: 3,
    finished: 2,
    by: 'Zoe',
  },
  {
    name: 'e',
    source: 'csv',
    status: 'pending',
    objects: ['deal'],
    found: 70,
    errors: 0,
    started: 2,
    finished: null,
    by: 'Bea',
  },
  {
    name: 'f',
    source: 'ghl',
    status: 'failed',
    objects: ['contact'],
    found: 0,
    errors: 0,
    started: 1,
    finished: 0,
    by: 'adam',
  },
];

/** The history above in a new business, written as imports store themselves. */
async function history(): Promise<{ space: Workspace; ids: ReadonlyMap<string, string> }> {
  const space = await workspace(database);
  const users = new Map<string, string>();
  for (const name of ['Zoe', 'adam', 'Bea']) {
    const user = await database.fixtures.user();
    users.set(name, user.id);
    people.set(user.id, name);
  }
  const ids = new Map<string, string>();
  for (const each of HISTORY) {
    const row = await database.withTenant(space.owner.context, (sql) =>
      sql.one<{ id: string }>(
        `insert into imports.jobs
           (business_id, source, status, objects, file_name, row_count, processed_count,
            failed_count, error_code, created_by_kind, created_by_id, created_at, started_at,
            finished_at, heartbeat_at)
         values (app.business_id(), $1, $2, $3::text[], $4, $5, $6, $6, $7, $8, $9,
                 '2026-06-10T00:00:00Z'::timestamptz - make_interval(days => $10),
                 '2026-06-10T00:00:00Z'::timestamptz - make_interval(days => $10),
                 '2026-06-10T00:00:00Z'::timestamptz - make_interval(days => $11), now())
         returning id`,
        [
          each.source,
          each.status,
          each.objects,
          `${each.name}.csv`,
          each.found,
          each.errors,
          each.status === 'failed' ? 'unknown' : null,
          each.by === null ? 'system' : 'user',
          each.by === null ? null : users.get(each.by),
          each.started,
          each.finished,
        ],
      ),
    );
    ids.set(each.name, toPublicId('import', row.id));
  }
  return { space, ids };
}

/** The file names of the history under an order, read a page of two at a time. */
async function walk(space: Workspace, query: Record<string, string>): Promise<string> {
  const seen: string[] = [];
  let after: string | undefined;
  do {
    const page = importList.parse(
      await api.call('listImports', space.owner, {
        query: { ...query, limit: '2', ...(after === undefined ? {} : { after }) },
      }),
    );
    expect(page.total).toBe(HISTORY.length);
    expect(page.items.length).toBeLessThanOrEqual(2);
    seen.push(...page.items.map((each) => (each.fileName ?? '').replace('.csv', '')));
    after = page.next ?? undefined;
  } while (after !== undefined);
  return seen.join('');
}

// Ascending. Ties keep the order the imports were started in (a before b before c …).
const ASCENDING: Readonly<Record<ImportSort, string>> = {
  started: 'abcdef',
  // The one that has not finished comes after every finished one.
  completed: 'acdbfe',
  source: 'acdebf',
  // By the name shown, whatever its case; the one with no name first.
  importedBy: 'bcfead',
  status: 'dabcfe',
  objects: 'cadfbe',
  found: 'fdbace',
  errors: 'acefbd',
};

const DESCENDING: Readonly<Record<ImportSort, string>> = {
  started: 'fedcba',
  completed: 'efbdca',
  source: 'fbedca',
  importedBy: 'daefcb',
  status: 'efcbad',
  objects: 'ebfdac',
  found: 'ecabdf',
  errors: 'dbfeca',
};

describe('the history of imports', () => {
  it.each(importSorts)('comes in the order of %s, up and down, a page at a time', async (sort) => {
    const { space } = await history();
    const ascending = ASCENDING[sort];
    expect(await walk(space, { sort, direction: 'asc' })).toBe(ascending);
    // Descending is the exact reverse, ties included: nothing changes place between pages.
    expect(await walk(space, { sort, direction: 'desc' })).toBe(DESCENDING[sort]);
    expect(await walk(space, { sort })).toBe(DESCENDING[sort]);
  });

  it('is newest first when no order is asked for, as it always was', async () => {
    const { space } = await history();
    expect(await walk(space, {})).toBe('fedcba');
  });

  it('keeps an order within its filters', async () => {
    const { space } = await history();
    const names = async (query: Record<string, string>): Promise<string> =>
      importList
        .parse(await api.call('listImports', space.owner, { query }))
        .items.map((each) => (each.fileName ?? '').replace('.csv', ''))
        .join('');
    expect(await names({ source: 'csv', sort: 'found', direction: 'desc' })).toBe('ecad');
    expect(await names({ status: 'failed', sort: 'importedBy', direction: 'asc' })).toBe('cf');
    expect(await names({ object: 'contact', sort: 'errors', direction: 'desc' })).toBe('dbfa');
  });

  it('refuses an order it does not have, and a page after an import that is not this business’s', async () => {
    const { space, ids } = await history();
    const other = await workspace(database);
    for (const query of [
      { sort: 'fileName' },
      { direction: 'up' },
      { sort: 'found', after: ids.get('a') ?? '', limit: '0' },
    ]) {
      await expect(api.call('listImports', space.owner, { query })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    await expect(
      api.call('listImports', other.owner, { query: { after: ids.get('a') ?? '' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      api.call('listImports', space.owner, {
        query: { after: toPublicId('import', '0199c7e2-0000-7000-8000-00000000000d') },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('an import that names no mode', () => {
  const mapping = [
    { column: 0, target: attribute('firstName') },
    { column: 1, target: attribute('email') },
  ];

  it('adds new contacts and changes none that exist, in the preview and when started', async () => {
    expect(DEFAULT_IMPORT_MODE).toBe('create');
    const space = await workspace(database);
    await database.fixtures.contact(space.owner.context, {
      firstName: 'Already',
      lastName: 'Here',
      email: 'here@example.test',
    });
    const file = await uploadCsv(
      files,
      services,
      space.owner,
      'First,Email\r\nChanged,here@example.test\r\nNew,new@example.test\r\n',
    );
    const body = { fileId: file.id, object: 'contact', mapping };
    const preview = importPreview.parse(await api.call('previewImport', space.owner, { body }));
    expect(preview.rows.map((row) => row.outcome)).toEqual(['skip', 'create']);
    const started = importJob.parse(await api.call('startImport', space.owner, { body }));
    expect(started.mode).toBe('create');
  });
});
