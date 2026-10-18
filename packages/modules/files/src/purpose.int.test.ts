// A file kept for one purpose, such as a bulk export's CSV of contacts: it is linked only by
// that purpose, never by the general link any file can have, and is never handed out as
// content (an import, an attachment). It counts against the business's quota when asked.
// Against a migrated Postgres and local storage.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import type { StoredFile } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';
import { localStorage } from '@repo/storage';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { createFiles, fileRoutes, type Files } from './index.js';

const CSV = Buffer.from('"Contact Name"\r\n"Maya Thompson"\r\n');

let database: TestDatabase;
let db: Database;
let services: Services;
let root: string;
let files: Files;
let tight: Files;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  root = await mkdtemp(join(tmpdir(), 'crm-files-purpose-'));
  const options = {
    storage: localStorage({ directory: join(root, 'storage') }),
    uploadDirectory: join(root, 'uploads'),
    maxBytes: 64 * 1024,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
  };
  files = createFiles(options);
  // A business may keep 40 bytes in all.
  tight = createFiles({ ...options, businessQuotaBytes: 40 });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
  await rm(root, { recursive: true, force: true });
});

async function inBusiness(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  return {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
}

/** Keeps the bytes as an export's file, with the files service given. */
const keepWith = (service: () => Files) =>
  defineCommand({
    name: 'fixture.keep_export',
    permission: 'contacts.manage',
    input: z.strictObject({ quota: z.boolean() }),
    handle: (trx, input, command): Promise<StoredFile> =>
      service().store(trx, command, {
        filename: 'Export_Contacts_2026-10-17.csv',
        contentType: 'text/csv',
        content: CSV,
        purpose: 'contact_export',
        quota: input.quota,
      }),
  });
const keeping = keepWith(() => files);
const keepingTight = keepWith(() => tight);

describe('a file kept for a purpose', () => {
  it('is linked only by its purpose, and never handed out as content', async () => {
    const invocation = await inBusiness();
    const stored = await runCommand(services, keeping, { quota: false }, invocation);

    // The general link of any file, as POST /files/{id}/links makes it, does not find it.
    const route = fileRoutes(files, { apiUrl: 'https://crm.example.com/api/v1' }).find(
      (each) => each.endpoint.operationId === 'createFileLink',
    );
    await expect(
      Promise.resolve(
        route?.run(
          { invocation, params: { id: stored.id }, query: {}, body: { expiresIn: 3600 } },
          services,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      files.link(services, invocation, stored.id, { seconds: 60 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Neither does an import or an attachment, which read a file's content.
    expect(await files.content(services, invocation, stored.id)).toBeUndefined();

    // Its own link opens it.
    const link = await files.link(services, invocation, stored.id, {
      seconds: 60,
      purpose: 'contact_export',
    });
    const query = Object.fromEntries(new URL(`https://x${link.path}`).searchParams);
    const opened = await files.open(db, {
      fileId: stored.id,
      query,
      now: new Date(),
      correlationId: randomUUID(),
    });
    expect('refused' in opened).toBe(false);
    if ('body' in opened) opened.body.destroy();
  });

  // A public address needs a library file (files_public_needs_live_library), so keeping it
  // out of the library keeps it from being public too.
  it('cannot be put in the media library, nor so made public', async () => {
    const invocation = await inBusiness();
    const stored = await runCommand(services, keeping, { quota: false }, invocation);
    const refusal = (statement: string) =>
      database
        .as('crm_owner', (sql) => sql.query(statement, [parsePublicId('file', stored.id)]))
        .then(
          () => '',
          (error: unknown) => String(error),
        );
    expect(await refusal('update files.files set library = true where id = $1')).toContain(
      'files_purpose_private',
    );
    expect(
      await refusal(
        "update files.files set library = true, public_key = 'AAAAAAAAAAAAAAAAAAAAAA' where id = $1",
      ),
    ).toContain('files_purpose_private');
  });

  it('counts against the business’s storage quota when asked to', async () => {
    const invocation = await inBusiness();
    // The first fits in 40 bytes; a second does not.
    await runCommand(services, keepingTight, { quota: true }, invocation);
    await expect(
      runCommand(services, keepingTight, { quota: true }, invocation),
    ).rejects.toMatchObject({ issues: [{ code: 'storage_full' }] });
    // Without the quota asked for, as an invoice's PDF is kept, it is not counted.
    expect(await runCommand(services, keepingTight, { quota: false }, invocation)).toMatchObject({
      filename: 'Export_Contacts_2026-10-17.csv',
    });
    await expect(
      runCommand(services, keepingTight, { quota: true }, invocation),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
