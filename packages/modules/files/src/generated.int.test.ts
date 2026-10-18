// Files the server makes itself, such as the PDF of an invoice being emailed: kept in the
// caller's own transaction, checked as an upload is, and read back in a transaction the
// caller already holds. Against a migrated Postgres and local storage.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { fileTypes, type StoredFile } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ConflictError, ContentTooLargeError, parsePublicId, ValidationError } from '@repo/kernel';
import { localStorage } from '@repo/storage';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { createFiles, type Files } from './index.js';

const MAX_BYTES = 64 * 1024;
const PDF = Buffer.from('%PDF-1.3\n% a fixture, not a document\n%%EOF\n');

let database: TestDatabase;
let db: Database;
let services: Services;
let root: string;
let files: Files;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  root = await mkdtemp(join(tmpdir(), 'crm-files-generated-'));
  files = createFiles({
    storage: localStorage({ directory: join(root, 'storage') }),
    uploadDirectory: join(root, 'uploads'),
    maxBytes: MAX_BYTES,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
  await rm(root, { recursive: true, force: true });
});

async function inBusiness(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  return {
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    // Not even the permission to upload: keeping a file the server made asks for none.
    permissions: new Set(['payments.manage']),
  };
}

const keep = z.strictObject({
  filename: z.string(),
  contentType: z.enum(fileTypes),
  content: z.instanceof(Uint8Array),
  fail: z.boolean().default(false),
});
/** A command of another module that keeps a file as part of its own work. */
const keeping = defineCommand({
  name: 'fixture.keep_file',
  permission: 'payments.manage',
  input: keep,
  audit: ({ filename }) => ({ filename }),
  async handle(trx, input, command): Promise<StoredFile> {
    const stored = await files.store(trx, command, input);
    if (input.fail) throw new ConflictError('The command failed after the file was kept.');
    return stored;
  },
});

const read = async (stream: Readable | undefined): Promise<Buffer> => {
  if (stream === undefined) throw new Error('Nothing to read.');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
};

const rowsOf = (invocation: Invocation) =>
  database.as('crm_owner', (sql) =>
    sql.query<{
      filename: string;
      content_type: string;
      size_bytes: string;
      uploaded_by_kind: string;
    }>(
      `select filename, content_type, size_bytes, uploaded_by_kind from files.files
       where business_id = $1 order by id`,
      [invocation.context.businessId],
    ),
  );

describe('a file the server made', () => {
  it('is kept as a file of the command’s business, with its bytes, and told of', async () => {
    const invocation = await inBusiness();
    const stored = await runCommand(
      services,
      keeping,
      { filename: 'INV-0007.pdf', contentType: 'application/pdf', content: PDF },
      invocation,
    );
    expect(stored).toMatchObject({
      filename: 'INV-0007.pdf',
      contentType: 'application/pdf',
      size: PDF.length,
    });
    expect(await rowsOf(invocation)).toEqual([
      {
        filename: 'INV-0007.pdf',
        content_type: 'application/pdf',
        size_bytes: String(PDF.length),
        uploaded_by_kind: 'user',
      },
    ]);
    // Read back through the service, and in a transaction the caller already holds.
    const found = await files.content(services, invocation, stored.id);
    expect(await read(await found?.open())).toEqual(PDF);
    const inTransaction = await withTenant(db, invocation.context, (trx) =>
      files.contentIn(trx, stored.id),
    );
    expect(inTransaction?.file).toEqual(stored);
    expect(inTransaction?.shared).toBe(false);
    expect(await read(await inTransaction?.open())).toEqual(PDF);
    const [event] = await database.as('crm_owner', (sql) =>
      sql.query<{ payload: unknown }>(
        "select payload from events.events where type = 'file.uploaded' and subject_id = $1",
        [parsePublicId('file', stored.id)],
      ),
    );
    expect(event?.payload).toEqual({
      filename: 'INV-0007.pdf',
      contentType: 'application/pdf',
      size: PDF.length,
      generated: true,
    });
  });

  it('is checked as an upload is: its type against its bytes, its size, its name', async () => {
    const invocation = await inBusiness();
    const store = (file: z.input<typeof keep>) => runCommand(services, keeping, file, invocation);
    await expect(
      store({ filename: 'x.pdf', contentType: 'application/pdf', content: Buffer.from('not one') }),
    ).rejects.toThrow(ValidationError);
    await expect(
      store({
        filename: 'x.pdf',
        contentType: 'application/pdf',
        content: Buffer.concat([PDF, Buffer.alloc(MAX_BYTES)]),
      }),
    ).rejects.toThrow(ContentTooLargeError);
    await expect(
      store({ filename: '', contentType: 'application/pdf', content: PDF }),
    ).rejects.toThrow('Give the file a name.');
    expect(await rowsOf(invocation)).toEqual([]);
  });

  it('leaves no row when the command that kept it fails', async () => {
    const invocation = await inBusiness();
    await expect(
      runCommand(
        services,
        keeping,
        { filename: 'INV-0008.pdf', contentType: 'application/pdf', content: PDF, fail: true },
        invocation,
      ),
    ).rejects.toThrow(ConflictError);
    expect(await rowsOf(invocation)).toEqual([]);
    // Nothing waited in the upload folder: the bytes never touched it.
    expect(await readdir(join(root, 'uploads')).catch(() => [])).toEqual([]);
  });

  it('is not read from another business, in a transaction or out of one', async () => {
    const ours = await inBusiness();
    const theirs = await inBusiness();
    const stored = await runCommand(
      services,
      keeping,
      { filename: 'INV-0009.pdf', contentType: 'application/pdf', content: PDF },
      theirs,
    );
    expect(
      await withTenant(db, ours.context, (trx) => files.contentIn(trx, stored.id)),
    ).toBeUndefined();
    expect(
      await withTenant(db, ours.context, (trx) => files.contentIn(trx, 'not-a-file')),
    ).toBeUndefined();
    expect(await files.content(services, ours, stored.id)).toBeUndefined();
  });
});
