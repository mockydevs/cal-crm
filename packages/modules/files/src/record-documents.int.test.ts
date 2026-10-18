// A record's documents in the files service, against a migrated Postgres and local
// storage: the bytes are checked and stored before any row is locked, kept by a command
// for its record alone, and removed from storage only after their deletion commits.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { documentFormats, type StoredFile } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';
import { localStorage, type Storage } from '@repo/storage';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { checkBusinessLogo, createFiles, type Files } from './index.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let root: string;
let storage: Storage;
let files: Files;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  root = await mkdtemp(join(tmpdir(), 'crm-record-documents-'));
  await mkdir(join(root, 'storage'));
  storage = localStorage({ directory: join(root, 'storage') });
  files = createFiles({
    storage,
    uploadDirectory: join(root, 'uploads'),
    maxBytes: 64 * 1024,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
  });
});

afterAll(async () => {
  await db.destroy();
  await database.close();
  await rm(root, { recursive: true, force: true });
});

const pdf = Buffer.from('%PDF-1.7\n'.padEnd(200, ' '));

async function inBusiness(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  return {
    context: {
      ...business.context,
      userId: user.id,
      actorKind: 'user',
      actorId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
}

const stored = async () =>
  (await readdir(join(root, 'storage'), { recursive: true, withFileTypes: true })).filter(
    (entry) => entry.isFile() && !entry.parentPath.includes('.tmp'),
  ).length;

/** Receives and stages bytes as a record's upload route does. */
async function stage(bytes: Buffer, filename: string) {
  const received = await files.receive(Readable.from([bytes]));
  try {
    return await files.stageDocument(services, received.upload, {
      filename,
      formats: documentFormats,
    });
  } finally {
    await received.discard();
  }
}

/** A command that keeps a staged document, as a record's attach command does. */
const keep = defineCommand({
  name: 'test.keep_document',
  permission: 'files.upload',
  input: z.strictObject({ staged: z.uuid() }),
  handle: (trx, input, command): Promise<StoredFile> =>
    files.keepStaged(trx, command, input.staged, {
      formats: documentFormats,
      purpose: 'record_file',
    }),
});

const discard = defineCommand({
  name: 'test.discard_document',
  permission: 'files.upload',
  input: z.strictObject({ id: z.uuid() }),
  handle: (trx, input, command) => files.discard(trx, command, input.id),
});

const keepCsv = defineCommand({
  name: 'test.keep_csv_document',
  permission: 'files.upload',
  input: z.strictObject({ staged: z.uuid() }),
  handle: (trx, input, command): Promise<StoredFile> =>
    files.keepStaged(trx, command, input.staged, {
      formats: ['csv'],
      purpose: 'record_file',
    }),
});

describe("a record's document", () => {
  it('refuses a received upload that was already discarded', async () => {
    const received = await files.receive(Readable.from([pdf]));
    await received.discard();
    const before = await stored();
    await expect(
      files.stageDocument(services, received.upload, {
        filename: 'gone.pdf',
        formats: documentFormats,
      }),
    ).rejects.toMatchObject({ issues: [{ path: '/upload', code: 'not_found' }] });
    expect(await stored()).toBe(before);
  });

  it('refuses a disallowed format before storing its bytes', async () => {
    const received = await files.receive(Readable.from([pdf]));
    const before = await stored();
    try {
      await expect(
        files.stageDocument(services, received.upload, { filename: 'brief.pdf', formats: ['csv'] }),
      ).rejects.toMatchObject({ issues: [{ path: '/filename', code: 'unsupported_type' }] });
      expect(await stored()).toBe(before);
    } finally {
      await received.discard();
    }
  });

  it('rechecks allowed formats when keeping a staged document without consuming a refused upload', async () => {
    const invocation = await inBusiness();
    const staged = await stage(pdf, 'brief.pdf');
    try {
      await expect(
        runCommand(services, keepCsv, { staged: staged.id }, invocation),
      ).rejects.toMatchObject({ issues: [{ path: '/filename', code: 'unsupported_type' }] });
      expect(await runCommand(services, keep, { staged: staged.id }, invocation)).toMatchObject({
        filename: 'brief.pdf',
        contentType: 'application/pdf',
      });
    } catch (error) {
      await staged.discard();
      throw error;
    }
  });

  it('refuses deletion from another business and leaves the document available to its owner', async () => {
    const invocation = await inBusiness();
    const staged = await stage(pdf, 'private.pdf');
    const kept = await runCommand(services, keep, { staged: staged.id }, invocation);
    const otherBusiness = await database.fixtures.business(invocation.context.agencyId);
    const other = {
      ...invocation,
      context: { ...invocation.context, businessId: otherBusiness.id },
    };
    await expect(runCommand(services, discard, { id: staged.id }, other)).rejects.toThrow(
      NotFoundError,
    );
    const link = await files.link(services, invocation, kept.id, {
      seconds: 60,
      purpose: 'record_file',
    });
    expect(link.path).toContain(`/files/${kept.id}/content?`);
  });

  it('refuses a second deletion of the same document', async () => {
    const invocation = await inBusiness();
    const staged = await stage(pdf, 'deleted.pdf');
    await runCommand(services, keep, { staged: staged.id }, invocation);
    await runCommand(services, discard, { id: staged.id }, invocation);
    await expect(runCommand(services, discard, { id: staged.id }, invocation)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('is checked and stored before a command keeps it, and kept for its record alone', async () => {
    const invocation = await inBusiness();
    const before = await stored();
    // Refused by its bytes before anything is stored.
    await expect(stage(Buffer.from('not a pdf'), 'brief.pdf')).rejects.toThrow(ValidationError);
    expect(await stored()).toBe(before);
    const staged = await stage(pdf, 'brief.pdf');
    expect(await stored()).toBe(before + 1);
    const kept = await runCommand(services, keep, { staged: staged.id }, invocation);
    expect(kept).toMatchObject({ filename: 'brief.pdf', contentType: 'application/pdf' });
    const [row] = await database.as('crm_owner', (sql) =>
      sql.query<{ purpose: string | null }>('select purpose from files.files where id = $1', [
        parsePublicId('file', kept.id),
      ]),
    );
    expect(row?.purpose).toBe('record_file');
    // Never by the general link of any file, nor as another thing's logo.
    await expect(files.link(services, invocation, kept.id, { seconds: 60 })).rejects.toThrow(
      NotFoundError,
    );
    await expect(
      withTenant(db, invocation.context, (trx) =>
        checkBusinessLogo(trx, invocation.context.businessId ?? '', kept.id),
      ),
    ).rejects.toThrow(NotFoundError);
    // A staged document is kept once.
    await expect(runCommand(services, keep, { staged: staged.id }, invocation)).rejects.toThrow(
      ValidationError,
    );
  });

  it('can be thrown away unkept, and then nothing of it is stored', async () => {
    const before = await stored();
    const staged = await stage(pdf, 'draft.pdf');
    await staged.discard();
    expect(await stored()).toBe(before);
  });

  it('keeps its bytes when its deletion is only marked, until the worker removes them', async () => {
    const invocation = await inBusiness();
    const staged = await stage(pdf, 'old.pdf');
    const kept = await runCommand(services, keep, { staged: staged.id }, invocation);
    const id = parsePublicId('file', kept.id) ?? '';
    const before = await stored();
    await runCommand(services, discard, { id }, invocation);
    // Marked deleted, the bytes still there: a transaction that failed after this would
    // have left them with their row.
    expect(await stored()).toBe(before);
    const task = files.tasks.find((each) => each.name === 'files.remove_bytes');
    if (task === undefined) throw new Error('The files service has no removal task.');
    const job = { invocation: { ...invocation, permissions: 'all' as const }, services };
    await task.run(task.data.parse({ fileId: id }), job);
    expect(await stored()).toBe(before - 1);
    // Run again, as a job may be: nothing left to remove, and no failure.
    await task.run(task.data.parse({ fileId: id }), job);
    expect(await stored()).toBe(before - 1);
  });

  it("removes nothing for a file that isn't deleted", async () => {
    const invocation = await inBusiness();
    const staged = await stage(pdf, 'live.pdf');
    const kept = await runCommand(services, keep, { staged: staged.id }, invocation);
    const before = await stored();
    const task = files.tasks.find((each) => each.name === 'files.remove_bytes');
    await task?.run(task.data.parse({ fileId: parsePublicId('file', kept.id) }), {
      invocation,
      services,
    });
    expect(await stored()).toBe(before);
  });
});
