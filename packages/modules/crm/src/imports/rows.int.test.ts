// Import rows against a migrated Postgres, with imports run as the worker
// runs them: what became of an import's rows, read without the error file, and the
// condition that finds the records an import made or changed.
import { allowEveryone, type Services } from '@repo/commands';
import { importJob, importRowList, type ImportJob } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ForbiddenError, NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  attribute,
  importApi,
  memoryFiles,
  runImportJob,
  uploadCsv,
  workspace,
  type Workspace,
} from '../../test/imports.js';
import { writtenByImport } from './imports.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let files: ReturnType<typeof memoryFiles>;
let api: ReturnType<typeof importApi>;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  files = memoryFiles(db);
  api = importApi(services, files);
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

const mapping = [
  { column: 0, target: attribute('firstName') },
  { column: 1, target: attribute('email') },
];

/** Imports the rows into the business and runs the job to its end. */
async function imported(
  space: Workspace,
  rows: readonly string[],
  mode: string,
): Promise<ImportJob> {
  const file = await uploadCsv(
    files,
    services,
    space.owner,
    `First,Email\r\n${rows.join('\r\n')}\r\n`,
  );
  const started = importJob.parse(
    await api.call('startImport', space.owner, {
      body: { fileId: file.id, object: 'contact', mode, mapping },
    }),
  );
  await runImportJob(services, files, space.system, started.id);
  return importJob.parse(await api.call('getImport', space.owner, { params: { id: started.id } }));
}

const SECRET = 'not-an-email-and-private';
/**
 * An import of five rows into a business that has Ada already: one row changes her, one
 * makes Grace, one is the same contact as an earlier row, and two cannot be read.
 */
async function mixed(): Promise<{ space: Workspace; job: ImportJob; adaId: string }> {
  const space = await workspace(database);
  const ada = await database.fixtures.contact(space.owner.context, {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.test',
  });
  const job = await imported(
    space,
    [
      'Augusta,ada@example.test',
      'Grace,grace@example.test',
      'Grace again,grace@example.test',
      `Broken,${SECRET}`,
      'Also broken,@',
    ],
    'create_and_update',
  );
  expect(job.counts).toMatchObject({ found: 5, created: 1, updated: 1, skipped: 1, failed: 2 });
  return { space, job, adaId: ada.id };
}

const rowsOf = async (space: Workspace, id: string, query: Record<string, string> = {}) =>
  importRowList.parse(await api.call('listImportRows', space.owner, { params: { id }, query }));

describe('the rows of an import', () => {
  it('are the ones that were not applied unless asked otherwise, each with its reason and nothing it held', async () => {
    const { space, job } = await mixed();
    const notApplied = await rowsOf(space, job.id);
    expect(notApplied.items.map(({ row, outcome }) => [row, outcome])).toEqual([
      // The header is row 1, as in the preview and the error file.
      [4, 'skipped'],
      [5, 'failed'],
      [6, 'failed'],
    ]);
    expect(notApplied).toMatchObject({ total: 3, next: null });
    for (const item of notApplied.items) {
      expect(item.code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(item.message).not.toBe('');
    }
    // The reason names the column by its header, never the cell.
    expect(notApplied.items[1]?.message).toContain('Email');
    expect(JSON.stringify(notApplied)).not.toContain(SECRET);
    expect(JSON.stringify(notApplied)).not.toContain('grace@example.test');

    expect((await rowsOf(space, job.id, { outcome: 'not_applied' })).items).toEqual(
      notApplied.items,
    );
    expect(
      (await rowsOf(space, job.id, { outcome: 'failed' })).items.map((item) => item.row),
    ).toEqual([5, 6]);
    expect(await rowsOf(space, job.id, { outcome: 'skipped' })).toMatchObject({
      items: [{ row: 4, outcome: 'skipped' }],
      total: 1,
    });
    // An applied row has no reason.
    expect((await rowsOf(space, job.id, { outcome: 'updated' })).items).toEqual([
      { row: 2, outcome: 'updated', code: null, message: null },
    ]);
    expect((await rowsOf(space, job.id, { outcome: 'created' })).items).toEqual([
      { row: 3, outcome: 'created', code: null, message: null },
    ]);
  });

  it('are read a page at a time in the file’s order', async () => {
    const { space, job } = await mixed();
    const first = await rowsOf(space, job.id, { limit: '2' });
    expect(first.items.map((item) => item.row)).toEqual([4, 5]);
    expect(first).toMatchObject({ total: 3, next: 5 });
    const second = await rowsOf(space, job.id, { limit: '2', after: String(first.next) });
    expect(second.items.map((item) => item.row)).toEqual([6]);
    expect(second).toMatchObject({ total: 3, next: null });
    for (const query of [{ limit: '0' }, { limit: '201' }, { after: '0' }, { outcome: 'lost' }])
      await expect(
        api.call('listImportRows', space.owner, { params: { id: job.id }, query }),
      ).rejects.toBeInstanceOf(ValidationError);
  });

  it('need contacts.import, and are not found for another business’s import whatever is asked', async () => {
    const { space, job } = await mixed();
    const other = await workspace(database);
    const reader = space.as(['contacts.manage']);
    const refusal: unknown = await api
      .call('listImportRows', reader, { params: { id: job.id } })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ForbiddenError);
    expect(refusal).toMatchObject({ permission: 'contacts.import' });
    expect(
      importRowList.parse(
        await api.call('listImportRows', space.as(['contacts.import']), { params: { id: job.id } }),
      ).total,
    ).toBe(3);
    for (const query of [{}, { outcome: 'lost' }])
      await expect(
        api.call('listImportRows', other.owner, { params: { id: job.id }, query }),
      ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('the records an import wrote', () => {
  const written = (space: Workspace, importId: string) =>
    withTenant(db, space.owner.context, (trx) =>
      trx
        .selectFrom('crm.contacts as c')
        .select('c.id')
        .where(writtenByImport('c.id', parsePublicId('import', importId) ?? ''))
        .orderBy('c.id')
        .execute(),
    ).then((rows) => rows.map((row) => row.id));

  it('are the ones it made or changed: not one it skipped, failed on, or never touched', async () => {
    const { space, job, adaId } = await mixed();
    const untouched = await database.fixtures.contact(space.owner.context, {
      firstName: 'Alan',
      lastName: 'Turing',
      email: 'alan@example.test',
    });
    const ids = await written(space, job.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(adaId);
    expect(ids).not.toContain(untouched.id);
    // A later import that only finds them there wrote neither.
    const again = await imported(
      space,
      ['Augusta,ada@example.test', 'Grace,grace@example.test'],
      'create',
    );
    expect(again.counts).toMatchObject({ created: 0, updated: 0, skipped: 2 });
    expect(await written(space, again.id)).toEqual([]);
    expect(await written(space, job.id)).toEqual(ids);
  });

  it('are nobody’s from another business: its import’s id finds nothing', async () => {
    const { space, job } = await mixed();
    const other = await workspace(database);
    const theirs = await imported(other, ['Grace,grace@example.test'], 'create');
    expect(await written(other, theirs.id)).toHaveLength(1);
    expect(await written(other, job.id)).toEqual([]);
    expect(await written(space, theirs.id)).toEqual([]);
  });
});
