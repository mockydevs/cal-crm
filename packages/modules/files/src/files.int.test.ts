// The files service against a migrated Postgres and local storage. Its acceptance criteria:
// a file from another business can't be fetched, even with its link after the link expires;
// uploads over the limit are refused before they're stored.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { storedFile, type StoredFile } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ContentTooLargeError,
  NotFoundError,
  parsePublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { localStorage, type Storage } from '@repo/storage';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { checkBusinessLogo, checkUserAvatar, createFiles, type Files } from './index.js';

const MAX_BYTES = 64 * 1024;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(2000),
]);

let database: TestDatabase;
let db: Database;
let services: Services;
let root: string;
let storage: Storage;
let files: Files;

describe('business logos', () => {
  it('accepts a live raster image and rejects deleted files and non-images', async () => {
    const invocation = await inBusiness();
    const businessId = invocation.context.businessId ?? '';
    const image = await upload(invocation, png);
    await withTenant(db, invocation.context, (trx) => checkBusinessLogo(trx, businessId, image.id));
    const text = await files.upload(services, invocation, {
      body: Readable.from('plain text'),
      filename: 'notes.txt',
      contentType: 'text/plain',
    });
    await expect(
      withTenant(db, invocation.context, (trx) => checkBusinessLogo(trx, businessId, text.id)),
    ).rejects.toThrow(ValidationError);
    await database.as('crm_owner', (sql) =>
      sql.query('update files.files set deleted_at = now() where id = $1', [
        parsePublicId('file', image.id),
      ]),
    );
    await expect(
      withTenant(db, invocation.context, (trx) => checkBusinessLogo(trx, businessId, image.id)),
    ).rejects.toThrow(NotFoundError);
  });
  it('rejects another business image and agency-shared images', async () => {
    const invocation = await inBusiness();
    const businessId = invocation.context.businessId ?? '';
    const otherBusiness = await database.fixtures.business(invocation.context.agencyId);
    const other = {
      ...invocation,
      context: { ...invocation.context, businessId: otherBusiness.id },
    };
    const { businessId: _business, ...context } = invocation.context;
    for (const uploader of [other, { ...invocation, context }]) {
      const image = await upload(uploader, png);
      await expect(
        withTenant(db, invocation.context, (trx) => checkBusinessLogo(trx, businessId, image.id)),
      ).rejects.toThrow(NotFoundError);
    }
  });
});

describe("a person's picture", () => {
  it('accepts a live raster image of the agency, up to 2.5 MB, and nothing else', async () => {
    const invocation = await inBusiness();
    const agencyId = invocation.context.agencyId;
    const check = (fileId: string, agency = agencyId) =>
      withTenant(db, invocation.context, (trx) => checkUserAvatar(trx, agency, fileId));
    const image = await upload(invocation, png);
    await check(image.id);
    const text = await files.upload(services, invocation, {
      body: Readable.from('plain text'),
      filename: 'notes.txt',
      contentType: 'text/plain',
    });
    await expect(check(text.id)).rejects.toMatchObject({
      issues: [{ path: '/avatarFileId', code: 'image_required' }],
    });
    // Another agency's file is not found, whoever asks.
    const elsewhere = await inBusiness();
    const theirs = await upload(elsewhere, png);
    await expect(check(theirs.id)).rejects.toThrow(NotFoundError);
    // The picture's own limit, which is smaller than the install's limit on a file.
    const setSize = (bytes: number) =>
      database.as('crm_owner', (sql) =>
        sql.query('update files.files set size_bytes = $2 where id = $1', [
          parsePublicId('file', image.id),
          bytes,
        ]),
      );
    await setSize(2_500_000);
    await check(image.id);
    await setSize(2_500_001);
    await expect(check(image.id)).rejects.toMatchObject({
      issues: [{ path: '/avatarFileId', code: 'image_too_large' }],
    });
    await setSize(2000);
    await database.as('crm_owner', (sql) =>
      sql.query('update files.files set deleted_at = now() where id = $1', [
        parsePublicId('file', image.id),
      ]),
    );
    await expect(check(image.id)).rejects.toThrow(NotFoundError);
  });
});

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  root = await mkdtemp(join(tmpdir(), 'crm-files-'));
  storage = localStorage({ directory: join(root, 'storage') });
  files = createFiles({
    storage,
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

function acting(context: TenantContext, userId: string): Invocation {
  return {
    context: {
      ...context,
      userId,
      actorKind: 'user',
      actorId: userId,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
}

/** Someone working in a business of their own, in a new agency. */
async function inBusiness(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  return acting(business.context, user.id);
}

/** Agency staff with no business selected. */
async function atAgency(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const { businessId: _business, ...agencyOnly } = business.context;
  return acting(agencyOnly, user.id);
}

function upload(
  invocation: Invocation,
  body: Buffer,
  contentType = 'image/png',
  filename = 'logo.png',
) {
  return files.upload(services, invocation, { body: Readable.from([body]), contentType, filename });
}

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

const stored = async () =>
  (await readdir(join(root, 'storage'), { recursive: true, withFileTypes: true })).filter(
    (entry) => entry.isFile() && !entry.parentPath.includes('.tmp'),
  ).length;
const waiting = async () => (await readdir(join(root, 'uploads'))).length;

/** The file's row as the database holds it, whatever its scope. */
async function row(file: StoredFile) {
  const [found] = await database.as('crm_owner', (sql) =>
    sql.query<{
      business_id: string | null;
      size_bytes: string;
      sha256: Buffer;
      storage_key: string;
    }>('select business_id, size_bytes, sha256, storage_key from files.files where id = $1', [
      parsePublicId('file', file.id),
    ]),
  );
  return found;
}

/** Opens a link's path (/files/{id}/content?…) as the download route would. */
function open(path: string, now = new Date()) {
  const url = new URL(path, 'https://crm.example.test');
  return files.open(db, {
    fileId: /^\/files\/([^/]+)\/content$/.exec(url.pathname)?.[1] ?? '',
    query: Object.fromEntries(url.searchParams),
    now,
    correlationId: randomUUID(),
  });
}

describe('uploading', () => {
  it("stores the bytes and records the file in the uploader's business", async () => {
    const invocation = await inBusiness();

    const file = storedFile.parse(await upload(invocation, png));

    expect(file).toMatchObject({
      filename: 'logo.png',
      contentType: 'image/png',
      size: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    });
    const record = await row(file);
    expect(record?.business_id).toBe(invocation.context.businessId);
    const bytes = await storage.get(record?.storage_key ?? '');
    expect(bytes && (await read(bytes))).toEqual(png);
    expect(await waiting()).toBe(0);
  });

  it('records a file.uploaded event and an audit row', async () => {
    const invocation = await inBusiness();

    const file = await upload(invocation, png);

    const [event] = await database.as('crm_owner', (sql) =>
      sql.query<{ type: string; payload: unknown }>(
        'select type, payload from events.events where subject_id = $1',
        [parsePublicId('file', file.id)],
      ),
    );
    expect(event).toEqual({
      type: 'file.uploaded',
      payload: { filename: 'logo.png', contentType: 'image/png', size: png.length },
    });
    const audits = await database.as('crm_owner', (sql) =>
      sql.query<{ outcome: string }>(
        "select outcome from audit.commands where command = 'file.create' and correlation_id = $1",
        [invocation.context.correlationId],
      ),
    );
    expect(audits).toEqual([{ outcome: 'ok' }]);
  });

  it("keeps agency staff's uploads at the agency, outside every business", async () => {
    const file = await upload(await atAgency(), png);

    expect((await row(file))?.business_id).toBeNull();
  });

  it('refuses an upload over the limit before anything is stored', async () => {
    const invocation = await inBusiness();
    const before = await stored();

    await expect(
      upload(invocation, Buffer.alloc(MAX_BYTES + 1, 0x20), 'text/plain'),
    ).rejects.toEqual(new ContentTooLargeError(MAX_BYTES));

    expect(await stored()).toBe(before);
    expect(await waiting()).toBe(0);
  });

  it('takes an upload of exactly the limit', async () => {
    const file = await upload(
      await inBusiness(),
      Buffer.alloc(MAX_BYTES, 0x20),
      'text/plain',
      'a.txt',
    );

    expect(file.size).toBe(MAX_BYTES);
  });

  it.each([
    ['a type that is not allowed', 'image/svg+xml', png, 'unsupported_type'],
    ['bytes that are not the type it says', 'application/pdf', png, 'type_mismatch'],
  ])('refuses %s, keeps nothing, and audits the attempt', async (_case, type, body, code) => {
    const invocation = await inBusiness();
    const before = await stored();

    const refused = upload(invocation, body, type);

    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    await expect(refused).rejects.toMatchObject({ issues: [{ code }] });
    expect(await stored()).toBe(before);
    expect(await waiting()).toBe(0);
    const audits = await database.as('crm_owner', (sql) =>
      sql.query<{ outcome: string }>(
        "select outcome from audit.commands where command = 'file.create' and correlation_id = $1",
        [invocation.context.correlationId],
      ),
    );
    expect(audits).toEqual([{ outcome: 'invalid' }]);
  });

  it('records who uploaded it, and no one for the system', async () => {
    const invocation = await inBusiness();
    const { userId: _user, actorId: _actor, ...system } = invocation.context;

    const byUser = await upload(invocation, png);
    const bySystem = await upload(
      { context: { ...system, actorKind: 'system' }, permissions: 'all' },
      png,
    );

    const uploaders = await database.as('crm_owner', (sql) =>
      sql.query<{ uploaded_by_kind: string; uploaded_by_id: string | null }>(
        'select uploaded_by_kind, uploaded_by_id from files.files where id = any($1) order by id',
        [[byUser, bySystem].map((file) => parsePublicId('file', file.id))],
      ),
    );
    expect(uploaders).toEqual([
      { uploaded_by_kind: 'user', uploaded_by_id: invocation.context.actorId },
      { uploaded_by_kind: 'system', uploaded_by_id: null },
    ]);
  });

  it.each([
    ['line breaks', 'logo\r\n.png'],
    ['a right-to-left override, which disguises an extension', 'invoice‮gnp.pdf'],
  ])('refuses a file name with %s', async (_case, filename) => {
    await expect(upload(await inBusiness(), png, 'image/png', filename)).rejects.toMatchObject({
      issues: [{ path: '/filename', code: 'invalid_format' }],
    });
  });
});

// file.create runs outside HTTP too, so it checks the upload itself rather than trust a caller.
describe('file.create, run directly', () => {
  const run = (invocation: Invocation, input: unknown) =>
    runCommand(services, files.createFileCommand, input, invocation);

  it('refuses an upload that is not there', async () => {
    await expect(
      run(await inBusiness(), {
        upload: randomUUID(),
        filename: 'a.txt',
        contentType: 'text/plain',
      }),
    ).rejects.toMatchObject({ issues: [{ path: '/upload', code: 'not_found' }] });
  });

  it('refuses an upload over the limit, however it got there', async () => {
    const name = randomUUID();
    await mkdir(join(root, 'uploads'), { recursive: true });
    await writeFile(join(root, 'uploads', name), Buffer.alloc(MAX_BYTES + 1, 0x20));
    const before = await stored();

    await expect(
      run(await inBusiness(), { upload: name, filename: 'a.txt', contentType: 'text/plain' }),
    ).rejects.toBeInstanceOf(ContentTooLargeError);
    expect(await stored()).toBe(before);
  });

  it('refuses an upload id that is not a UUID, so it names nothing outside the directory', async () => {
    await expect(
      run(await inBusiness(), {
        upload: '../../etc/passwd',
        filename: 'a',
        contentType: 'text/plain',
      }),
    ).rejects.toMatchObject({ issues: [{ path: '/upload' }] });
  });
});

describe('links', () => {
  it("open an agency's own file in the agency's scope", async () => {
    const invocation = await atAgency();
    const file = await upload(invocation, png);

    const link = await files.link(services, invocation, file.id, { seconds: 60 });

    expect(new URL(link.path, 'https://crm.example.test').searchParams.has('business')).toBe(false);
    const opened = await open(link.path);
    if (!('body' in opened)) throw new Error(`Refused: ${opened.refused}`);
    expect(await read(opened.body)).toEqual(png);
  });

  it('are refused for an id that is not a file id', async () => {
    await expect(
      files.link(services, await inBusiness(), 'tag_01h455vb4pex5vsknk084sn02q', { seconds: 60 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('open the file: its bytes, type and name, and whether it may show inline', async () => {
    const invocation = await inBusiness();
    const file = await upload(invocation, png);

    const link = await files.link(services, invocation, file.id, { seconds: 600 });
    const opened = await open(link.path);

    if (!('body' in opened)) throw new Error(`Refused: ${opened.refused}`);
    expect(await read(opened.body)).toEqual(png);
    expect(opened).toMatchObject({
      filename: 'logo.png',
      contentType: 'image/png',
      size: png.length,
      inline: true,
    });
  });

  it('say when they expire', async () => {
    const invocation = await inBusiness();
    const file = await upload(invocation, png, 'text/plain', 'notes.txt');
    const now = new Date();

    const link = await files.link(services, invocation, file.id, { seconds: 60, now });

    expect(link.expiresAt).toBe(
      new Date(Math.floor(now.getTime() / 1000) * 1000 + 60_000).toISOString(),
    );
    expect(await open(link.path, new Date(now.getTime() + 61_000))).toEqual({ refused: 'expired' });
  });

  it("can't be made for another business's file", async () => {
    const ours = await inBusiness();
    const theirs = await inBusiness();
    const file = await upload(theirs, png);

    await expect(files.link(services, ours, file.id, { seconds: 60 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("can't be turned to another business's file", async () => {
    const ours = await inBusiness();
    const theirs = await inBusiness();
    const ourFile = await upload(ours, png);
    const theirFile = await upload(theirs, png);

    const link = await files.link(services, ours, ourFile.id, { seconds: 60 });

    expect(await open(link.path.replace(ourFile.id, theirFile.id))).toEqual({ refused: 'invalid' });
  });

  it("can't be read in the agency's scope instead of the business's", async () => {
    const invocation = await inBusiness();
    const file = await upload(invocation, png);
    const link = await files.link(services, invocation, file.id, { seconds: 60 });

    const widened = new URL(link.path, 'https://crm.example.test');
    widened.searchParams.delete('business');

    expect(await open(`${widened.pathname}${widened.search}`)).toEqual({ refused: 'invalid' });
  });

  it('stop working when the file is deleted', async () => {
    const invocation = await inBusiness();
    const file = await upload(invocation, png);
    const link = await files.link(services, invocation, file.id, { seconds: 60 });

    await database.as('crm_owner', (sql) =>
      sql.query('update files.files set deleted_at = now() where id = $1', [
        parsePublicId('file', file.id),
      ]),
    );

    expect(await open(link.path)).toEqual({ refused: 'not_found' });
  });

  it('refuse an id that is not a file id', async () => {
    const opened = await files.open(db, {
      fileId: 'tag_01h455vb4pex5vsknk084sn02q',
      query: {},
      now: new Date(),
      correlationId: randomUUID(),
    });

    expect(opened).toEqual({ refused: 'not_found' });
  });

  it("fail loudly when a recorded file's bytes are missing from storage", async () => {
    const invocation = await inBusiness();
    const file = await upload(invocation, png);
    const link = await files.link(services, invocation, file.id, { seconds: 60 });
    await storage.delete((await row(file))?.storage_key ?? '');

    await expect(open(link.path)).rejects.toThrow(`The bytes of file ${file.id} are missing.`);
  });
});

// Work on a file's own contents, such as an import reading a CSV file, goes through
// content(): the same row-level security as a link, with no link in between.
describe('content', () => {
  it("gives a business's own file with its bytes, and says it is not shared", async () => {
    const invocation = await inBusiness();
    const csv = Buffer.from('Name,Email\r\nMaya,maya@example.test\r\n');
    const file = await upload(invocation, csv, 'text/csv', 'contacts.csv');

    const found = await files.content(services, invocation, file.id);

    expect(found?.file).toEqual(file);
    expect(found?.shared).toBe(false);
    expect(await read((await found?.open()) ?? Readable.from([]))).toEqual(csv);
    // Opened again, it is read from its start again.
    expect(await read((await found?.open()) ?? Readable.from([]))).toEqual(csv);
  });

  it("says an agency's own file is shared, when a business of the agency reads it", async () => {
    const invocation = await inBusiness();
    const { businessId: _business, ...agencyOnly } = invocation.context;
    const file = await upload({ ...invocation, context: agencyOnly }, png);

    expect((await files.content(services, invocation, file.id))?.shared).toBe(true);
  });

  it("finds nothing for another business's file, a deleted file, or an id that is no file's", async () => {
    const ours = await inBusiness();
    const theirs = await inBusiness();
    const neighbour = {
      ...ours,
      context: {
        ...ours.context,
        businessId: (await database.fixtures.business(ours.context.agencyId)).id,
      },
    };
    const theirFile = await upload(theirs, png);
    const neighbourFile = await upload(neighbour, png);
    const gone = await upload(ours, png);
    await database.as('crm_owner', (sql) =>
      sql.query('update files.files set deleted_at = now() where id = $1', [
        parsePublicId('file', gone.id),
      ]),
    );

    for (const id of [theirFile.id, neighbourFile.id, gone.id, 'tag_01h455vb4pex5vsknk084sn02q'])
      expect(await files.content(services, ours, id)).toBeUndefined();
    expect(await files.content(services, theirs, theirFile.id)).toBeDefined();
  });

  it("fails loudly when a recorded file's bytes are missing from storage", async () => {
    const invocation = await inBusiness();
    const file = await upload(invocation, png);
    await storage.delete((await row(file))?.storage_key ?? '');

    const found = await files.content(services, invocation, file.id);

    await expect(found?.open()).rejects.toThrow(`The bytes of file ${file.id} are missing.`);
  });
});
