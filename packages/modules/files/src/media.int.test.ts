// The media library against a migrated Postgres and local storage: what appears in it,
// folders, rename, move, delete with its object, public addresses, previews, the quota, and
// that another business sees none of it.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import {
  mediaFile,
  mediaFileDetail,
  mediaFileList,
  mediaFolder,
  mediaFolderList,
  mediaUsage,
  MEDIA_FOLDER_MAX_DEPTH,
  type MediaFile,
  type MediaFolder,
  type MediaSort,
  type Permission,
  type StoredFile,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { localStorage, type Storage } from '@repo/storage';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFiles, createMedia, type Files, type FoundMedia, type Media } from './index.js';

const PUBLIC_URL = 'https://crm.example.test';
const LINK_SECRET = 'a-files-link-secret-of-32-characters-or-more';
const MAX_BYTES = 64 * 1024;
const NOW = new Date('2026-10-12T20:15:00.000Z');

const png = (bytes = 200) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(bytes),
  ]);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(64)]);
const mp4 = () =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), randomBytes(500)]);
const mp3 = () => Buffer.concat([Buffer.from('ID3'), randomBytes(90)]);

let database: TestDatabase;
let db: Database;
let services: Services;
let root: string;
let storage: Storage;
/** Set to make the storage backend refuse deletes, as a service that is down would. */
let storageDown = false;
let files: Files;
let media: Media;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  root = await mkdtemp(join(tmpdir(), 'crm-media-'));
  const local = localStorage({ directory: join(root, 'storage') });
  storage = {
    ...local,
    delete: (key) =>
      storageDown ? Promise.reject(new Error('The storage service is down.')) : local.delete(key),
  };
  const options = {
    storage,
    uploadDirectory: join(root, 'uploads'),
    maxBytes: MAX_BYTES,
    linkSecret: LINK_SECRET,
  };
  files = createFiles(options);
  media = createMedia({ ...options, publicUrl: PUBLIC_URL, servesPublic: true, now: () => NOW });
});

afterAll(async () => {
  await db.destroy();
  await database.close();
  await rm(root, { recursive: true, force: true });
});

function acting(
  context: TenantContext,
  userId: string,
  permissions: Invocation['permissions'] = 'all',
): Invocation {
  return {
    context: {
      ...context,
      userId,
      actorKind: 'user',
      actorId: userId,
      correlationId: randomUUID(),
    },
    permissions,
  };
}

/** Someone working in a business of their own, in a new agency. */
async function inBusiness(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  return acting(business.context, user.id);
}

const withOnly = (invocation: Invocation, ...permissions: Permission[]): Invocation => ({
  ...invocation,
  permissions: new Set(permissions),
});

function add(
  invocation: Invocation,
  filename: string,
  body: Buffer = png(),
  contentType = 'image/png',
  folderId: string | null = null,
): Promise<StoredFile> {
  return files.upload(services, invocation, {
    body: Readable.from([body]),
    contentType,
    filename,
    library: { folderId },
  });
}

const list = async (invocation: Invocation, query: Record<string, unknown> = {}) =>
  mediaFileList.parse(await media.list(services, invocation, query));
const names = (page: { items: readonly MediaFile[] }) => page.items.map((item) => item.name);

const folder = (invocation: Invocation, name: string, parentId: string | null = null) =>
  runCommand(services, media.folders.create, { name, parentId }, invocation);
const folders = async (invocation: Invocation) =>
  mediaFolderList.parse(await media.folderList(services, invocation)).items;

const update = (invocation: Invocation, id: string, change: Record<string, unknown>) =>
  runCommand(services, media.commands.update, { id, ...change }, invocation);
const move = (invocation: Invocation, ids: string[], folderId: string | null) =>
  runCommand(services, media.commands.move, { ids, folderId }, invocation);
const remove = (invocation: Invocation, ...ids: string[]) =>
  runCommand(services, media.commands.remove, { ids }, invocation);

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

const stored = async () =>
  (await readdir(join(root, 'storage'), { recursive: true, withFileTypes: true })).filter(
    (entry) => entry.isFile() && !entry.parentPath.includes('.tmp'),
  ).length;

/** The value, which the test expects to be there. */
function present<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) throw new Error('Expected a value.');
  return value;
}

const uuid = (fileId: string) => parsePublicId('file', fileId) ?? '';

/** An id no row has: a random UUID with the version a public id takes. */
const uuidv7 = () => randomUUID().replace(/^(.{14})./, '$17');

/** The file's row as the database holds it, whatever its scope. */
async function row(fileId: string) {
  const [found] = await database.as('crm_owner', (sql) =>
    sql.query<{
      library: boolean;
      folder_id: string | null;
      public_key: string | null;
      deleted_at: Date | null;
      storage_key: string;
      filename: string;
    }>(
      'select library, folder_id, public_key, deleted_at, storage_key, filename from files.files where id = $1',
      [uuid(fileId)],
    ),
  );
  if (found === undefined) throw new Error('Expected the row.');
  return found;
}

/** Opens a preview address as the server's route would. */
function preview(address: string, now = NOW) {
  const url = new URL(address);
  return media.findPreview(db, {
    fileId: /^\/m\/p\/([^/]+)$/.exec(url.pathname)?.[1] ?? '',
    query: Object.fromEntries(url.searchParams),
    now,
    correlationId: randomUUID(),
  });
}

/** Opens a public address as the server's route would. */
function open(address: string): Promise<FoundMedia | undefined> {
  const key = /^\/m\/([^/]+)\/[^/]+$/.exec(new URL(address).pathname)?.[1] ?? '';
  return media.findPublic(db, { key, correlationId: randomUUID() });
}

describe('what is in the library', () => {
  it('holds only what was uploaded into it', async () => {
    const invocation = await inBusiness();
    const inLibrary = await add(invocation, 'storefront.png');
    // A logo, an attachment or an import is a file too, and never offered here.
    await files.upload(services, invocation, {
      body: Readable.from([png()]),
      contentType: 'image/png',
      filename: 'attachment.png',
    });

    const page = await list(invocation);

    expect(page.items.map((item) => item.id)).toEqual([inLibrary.id]);
    expect(page).toMatchObject({ canManage: true, canPublish: true, nextCursor: null });
    expect(page.items[0]).toMatchObject({
      name: 'storefront.png',
      contentType: 'image/png',
      kind: 'image',
      size: inLibrary.size,
      folderId: null,
      public: false,
      publicUrl: null,
    });
    expect((await row(inLibrary.id)).library).toBe(true);
  });

  it('shows another business nothing, and finds none of its files by id', async () => {
    const mine = await inBusiness();
    const file = await add(mine, 'mine.png');
    const made = await folder(mine, 'Mine');
    const sibling = await database.fixtures.business(mine.context.agencyId);
    const theirs = { ...mine, context: { ...mine.context, businessId: sibling.id } };
    const stranger = await inBusiness();

    for (const other of [theirs, stranger]) {
      expect((await list(other)).items).toEqual([]);
      expect(await folders(other)).toEqual([]);
      await expect(media.read(services, other, file.id)).rejects.toThrow(NotFoundError);
      await expect(update(other, file.id, { name: 'taken.png' })).rejects.toThrow(NotFoundError);
      await expect(move(other, [file.id], null)).rejects.toThrow(NotFoundError);
      await expect(remove(other, file.id)).rejects.toThrow(NotFoundError);
      await expect(add(other, 'into-yours.png', png(), 'image/png', made.id)).rejects.toThrow(
        NotFoundError,
      );
      await expect(
        runCommand(services, media.folders.update, { id: made.id, name: 'Taken' }, other),
      ).rejects.toThrow(NotFoundError);
      expect(mediaUsage.parse(await media.usage(services, other))).toMatchObject({
        files: 0,
        bytes: 0,
      });
    }
    expect((await row(file.id)).filename).toBe('mine.png');
    expect(names(await list(mine))).toEqual(['mine.png']);
  });

  it('asks agency staff to choose a business first', async () => {
    const invocation = await inBusiness();
    const { businessId: _business, ...agencyOnly } = invocation.context;
    const staff = { ...invocation, context: agencyOnly };

    expect(() => media.list(services, staff, {})).toThrow(ValidationError);
    expect(() => media.usage(services, staff)).toThrow(ValidationError);
    expect(() => media.folderList(services, staff)).toThrow(ValidationError);
    await expect(
      files.upload(services, staff, {
        body: Readable.from([png()]),
        contentType: 'image/png',
        filename: 'agency.png',
        library: { folderId: null },
      }),
    ).rejects.toMatchObject({ issues: [{ code: 'business_required' }] });
  });

  it("needs the library's own permission to upload into it, and tells who may change it", async () => {
    const invocation = await inBusiness();
    const uploader = withOnly(invocation, 'files.upload');
    const before = await stored();

    await expect(add(uploader, 'no.png')).rejects.toEqual(
      new ForbiddenError("Your role can't add files to the media library.", 'media.manage'),
    );

    expect(await stored()).toBe(before);
    expect((await list(uploader)).canManage).toBe(false);
    expect((await folders(uploader)).length).toBe(0);
    expect(mediaFolderList.parse(await media.folderList(services, uploader)).canManage).toBe(false);
    await add(withOnly(invocation, 'files.upload', 'media.manage'), 'yes.png');
    expect(names(await list(invocation))).toEqual(['yes.png']);
  });
});

describe('listing', () => {
  async function library() {
    const invocation = await inBusiness();
    const photos = await folder(invocation, 'Photos');
    await add(invocation, 'Banner.png', png(900));
    await add(invocation, 'alpha.png', png(100), 'image/png', photos.id);
    await add(invocation, 'price-list.pdf', pdf(), 'application/pdf');
    await add(invocation, 'tour.mp4', mp4(), 'video/mp4');
    await add(invocation, 'jingle.mp3', mp3(), 'audio/mpeg', photos.id);
    await add(invocation, 'notes 100%_final.txt', Buffer.from('notes'), 'text/plain');
    return { invocation, photos };
  }

  it('reads a folder, the top of the library, or every folder', async () => {
    const { invocation, photos } = await library();

    expect(names(await list(invocation, { folder: photos.id, sort: 'name_asc' }))).toEqual([
      'alpha.png',
      'jingle.mp3',
    ]);
    expect(names(await list(invocation, { folder: 'root', sort: 'name_asc' }))).toEqual([
      'Banner.png',
      'notes 100%_final.txt',
      'price-list.pdf',
      'tour.mp4',
    ]);
    expect((await list(invocation)).items).toHaveLength(6);
    expect(names(await list(invocation, { folder: toPublicId('media_folder', uuidv7()) }))).toEqual(
      [],
    );
  });

  it('sorts by the time changed, the name and the size, both ways', async () => {
    const { invocation } = await library();
    const sorted = async (sort: MediaSort) => names(await list(invocation, { sort }));
    const byName = [
      'alpha.png',
      'Banner.png',
      'jingle.mp3',
      'notes 100%_final.txt',
      'price-list.pdf',
      'tour.mp4',
    ];
    const uploaded = [
      'Banner.png',
      'alpha.png',
      'price-list.pdf',
      'tour.mp4',
      'jingle.mp3',
      'notes 100%_final.txt',
    ];

    expect(await sorted('name_asc')).toEqual(byName);
    expect(await sorted('name_desc')).toEqual([...byName].reverse());
    expect(await sorted('modified_asc')).toEqual(uploaded);
    expect(await sorted('modified_desc')).toEqual([...uploaded].reverse());
    const bySize = await sorted('size_asc');
    expect(bySize.at(0)).toBe('notes 100%_final.txt');
    expect(bySize.at(-1)).toBe('Banner.png');
    expect(await sorted('size_desc')).toEqual([...bySize].reverse());
  });

  it('puts a renamed file first among the newest', async () => {
    const { invocation } = await library();
    const [oldest] = (await list(invocation, { sort: 'modified_asc' })).items;

    await update(invocation, oldest?.id ?? '', { name: 'Renamed.png' });

    expect(names(await list(invocation)).at(0)).toBe('Renamed.png');
  });

  it('filters by type group, by a public address, and by part of a name in any case', async () => {
    const { invocation, photos } = await library();
    const filtered = async (query: Record<string, unknown>) =>
      names(await list(invocation, { sort: 'name_asc', ...query }));

    expect(await filtered({ kind: 'image' })).toEqual(['alpha.png', 'Banner.png']);
    expect(await filtered({ kind: 'video' })).toEqual(['tour.mp4']);
    expect(await filtered({ kind: 'audio' })).toEqual(['jingle.mp3']);
    expect(await filtered({ kind: 'document' })).toEqual([
      'notes 100%_final.txt',
      'price-list.pdf',
    ]);
    expect(await filtered({ search: 'BANNER' })).toEqual(['Banner.png']);
    expect(await filtered({ search: '.p' })).toEqual(['alpha.png', 'Banner.png', 'price-list.pdf']);
    // A search's own % and _ are text, not a pattern.
    expect(await filtered({ search: '100%_' })).toEqual(['notes 100%_final.txt']);
    expect(await filtered({ search: '%' })).toEqual(['notes 100%_final.txt']);
    expect(await filtered({ search: 'a_p' })).toEqual([]);
    expect(await filtered({ search: 'a', kind: 'image', folder: photos.id })).toEqual([
      'alpha.png',
    ]);
    expect(await filtered({ search: '   ' })).toHaveLength(6);

    const [banner] = (await list(invocation, { search: 'banner' })).items;
    await update(invocation, banner?.id ?? '', { public: true });
    expect(await filtered({ visibility: 'public' })).toEqual(['Banner.png']);
  });

  it.each([
    'name_asc',
    'name_desc',
    'modified_desc',
    'modified_asc',
    'size_asc',
    'size_desc',
  ] as const)('pages through every file once, in order, sorted by %s', async (sort) => {
    const { invocation } = await library();
    // Two files of one size and one name: only the id tells them apart.
    const twin = png(300);
    await add(invocation, 'twin.png', twin);
    await add(invocation, 'twin.png', twin);
    const whole = (await list(invocation, { sort })).items.map((item) => item.id);
    expect(whole).toHaveLength(8);

    const paged: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list(invocation, {
        sort,
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.items.length).toBeLessThanOrEqual(3);
      paged.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 10);

    expect(pages).toBe(3);
    expect(paged).toEqual(whole);
  });

  it('refuses a cursor it did not write, or one read in another sort', async () => {
    const { invocation } = await library();
    const { nextCursor } = await list(invocation, { sort: 'name_asc', limit: 2 });

    for (const query of [
      { sort: 'size_asc', cursor: nextCursor },
      { sort: 'name_asc', cursor: 'not-a-cursor' },
    ])
      expect(() => media.list(services, invocation, query)).toThrow(
        new ValidationError([
          {
            path: '/cursor',
            code: 'invalid_cursor',
            message: 'Send a nextCursor unchanged, with the sort it was read in.',
          },
        ]),
      );
  });

  it('counts what the library and the business hold', async () => {
    const invocation = await inBusiness();
    const first = await add(invocation, 'a.png', png(100));
    const second = await add(invocation, 'b.png', png(300));
    const elsewhere = await files.upload(services, invocation, {
      body: Readable.from([pdf()]),
      contentType: 'application/pdf',
      filename: 'invoice.pdf',
    });

    expect(mediaUsage.parse(await media.usage(services, invocation))).toEqual({
      files: 2,
      bytes: first.size + second.size,
      businessBytes: first.size + second.size + elsewhere.size,
      quotaBytes: null,
      maxFileBytes: MAX_BYTES,
    });
  });
});

describe('a file', () => {
  it('is read with where it is used', async () => {
    const invocation = await inBusiness();
    const file = await add(invocation, 'logo.png');

    const before = mediaFileDetail.parse(await media.read(services, invocation, file.id));
    expect(before).toMatchObject({ id: file.id, sha256: file.sha256, usedIn: [] });

    await database.as('crm_owner', (sql) =>
      sql.query('update tenancy.businesses set logo_file_id = $2 where id = $1', [
        invocation.context.businessId,
        uuid(file.id),
      ]),
    );
    expect((await media.read(services, invocation, file.id)).usedIn).toEqual(['business_logo']);
    await expect(media.read(services, invocation, 'file_nope')).rejects.toThrow(NotFoundError);
  });

  it('is renamed, keeping its id, its bytes and its public address', async () => {
    const invocation = await inBusiness();
    const file = await add(invocation, 'IMG_0001.png');
    const published = mediaFile.parse(await update(invocation, file.id, { public: true }));

    const renamed = mediaFile.parse(
      await update(invocation, file.id, { name: '  Shop front été.png  ' }),
    );

    expect(renamed).toMatchObject({ id: file.id, name: 'Shop front été.png', public: true });
    const key = (await row(file.id)).public_key ?? '';
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(published.publicUrl).toBe(`${PUBLIC_URL}/m/${key}/IMG_0001.png`);
    expect(renamed.publicUrl).toBe(`${PUBLIC_URL}/m/${key}/Shop%20front%20%C3%A9t%C3%A9.png`);
    // The old address still opens it: the key alone finds the file.
    expect(await open(published.publicUrl ?? '')).toMatchObject({ filename: 'Shop front été.png' });
  });

  it.each([
    ['an empty name', { name: '   ' }],
    ['a name with a line break', { name: 'a\nb.png' }],
    ['a name that hides its extension', { name: 'invoice‮gnp.exe' }],
    ['a name over 255 characters', { name: `${'a'.repeat(252)}.png` }],
    ['nothing to change', {}],
    ['something else', { size: 1 }],
  ])('refuses %s', async (_case, change) => {
    const invocation = await inBusiness();
    const file = await add(invocation, 'kept.png');

    await expect(update(invocation, file.id, change)).rejects.toThrow(ValidationError);

    expect((await row(file.id)).filename).toBe('kept.png');
  });

  it('records each change as an event and an audit row, and none when nothing changed', async () => {
    const invocation = await inBusiness();
    const file = await add(invocation, 'a.png');
    const made = await folder(invocation, 'Folder');

    await update(invocation, file.id, { name: 'a.png' });
    await update(invocation, file.id, { name: 'b.png', public: true });
    await update(invocation, file.id, { public: true });
    await move(invocation, [file.id], made.id);
    await move(invocation, [file.id], made.id);
    await update(invocation, file.id, { public: false });
    await remove(invocation, file.id);

    const events = await database.as('crm_owner', (sql) =>
      sql.query<{ type: string; payload: unknown }>(
        "select type, payload from events.events where subject_id = $1 and type <> 'file.uploaded' order by recorded_at, id",
        [uuid(file.id)],
      ),
    );
    expect(events).toEqual([
      { type: 'file.updated', payload: { renamed: true, published: true, unpublished: false } },
      { type: 'file.moved', payload: { folderId: made.id } },
      { type: 'file.updated', payload: { renamed: false, published: false, unpublished: true } },
      { type: 'file.deleted', payload: { filename: 'b.png', size: file.size } },
    ]);
    const audits = await database.as('crm_owner', (sql) =>
      sql.query<{ command: string }>(
        "select command from audit.commands where correlation_id = $1 and outcome = 'ok' order by command",
        [invocation.context.correlationId],
      ),
    );
    expect(audits.map((audit) => audit.command)).toEqual([
      'file.create',
      'media.create_folder',
      'media.delete',
      'media.move',
      'media.move',
      'media.update',
      'media.update',
      'media.update',
      'media.update',
    ]);
  });
});

describe('folders', () => {
  it('nest, list by name with their file counts, and hold uploads', async () => {
    const invocation = await inBusiness();
    const brand = mediaFolder.parse(await folder(invocation, '  Brand  '));
    const logos = await folder(invocation, 'Logos', brand.id);
    await folder(invocation, 'archive');
    await add(invocation, 'mark.png', png(), 'image/png', logos.id);
    await add(invocation, 'word.png', png(), 'image/png', logos.id);
    const gone = await add(invocation, 'old.png', png(), 'image/png', logos.id);
    await remove(invocation, gone.id);

    expect(brand).toMatchObject({ name: 'Brand', parentId: null, fileCount: 0 });
    expect(
      (await folders(invocation)).map(({ name, parentId, fileCount }) => ({
        name,
        parentId,
        fileCount,
      })),
    ).toEqual([
      { name: 'archive', parentId: null, fileCount: 0 },
      { name: 'Brand', parentId: null, fileCount: 0 },
      { name: 'Logos', parentId: brand.id, fileCount: 2 },
    ]);
  });

  it('refuse a name a sibling has, in any case, and allow it in another folder', async () => {
    const invocation = await inBusiness();
    const brand = await folder(invocation, 'Brand');

    await expect(folder(invocation, ' brand ')).rejects.toEqual(
      new ConflictError('A folder with that name already exists there.'),
    );
    const inner = await folder(invocation, 'Brand', brand.id);
    const other = await folder(invocation, 'Other');
    await expect(
      runCommand(services, media.folders.update, { id: other.id, name: 'BRAND' }, invocation),
    ).rejects.toThrow(ConflictError);
    await expect(
      runCommand(services, media.folders.update, { id: inner.id, parentId: null }, invocation),
    ).rejects.toThrow(ConflictError);
    expect(await folders(invocation)).toHaveLength(3);
  });

  it('are renamed and moved, and a change that changes nothing is not an event', async () => {
    const invocation = await inBusiness();
    const brand = await folder(invocation, 'Brand');
    const logos = await folder(invocation, 'Logos');

    const moved = await runCommand(
      services,
      media.folders.update,
      { id: logos.id, parentId: brand.id, name: 'Marks' },
      invocation,
    );
    const same = await runCommand(
      services,
      media.folders.update,
      { id: logos.id, name: 'Marks' },
      invocation,
    );

    expect(moved).toMatchObject({ id: logos.id, name: 'Marks', parentId: brand.id });
    expect(same).toMatchObject({ name: 'Marks', parentId: brand.id });
    const events = await database.as('crm_owner', (sql) =>
      sql.query<{ type: string; payload: unknown }>(
        'select type, payload from events.events where subject_id = $1 order by recorded_at, id',
        [parsePublicId('media_folder', logos.id)],
      ),
    );
    expect(events).toEqual([
      { type: 'media.folder_created', payload: { name: 'Logos' } },
      { type: 'media.folder_updated', payload: { moved: true, renamed: true } },
    ]);
  });

  it('never move into themselves or a folder inside them', async () => {
    const invocation = await inBusiness();
    const a = await folder(invocation, 'A');
    const b = await folder(invocation, 'B', a.id);
    const c = await folder(invocation, 'C', b.id);

    for (const parentId of [a.id, b.id, c.id])
      await expect(
        runCommand(services, media.folders.update, { id: a.id, parentId }, invocation),
      ).rejects.toMatchObject({ issues: [{ path: '/parentId', code: 'folder_inside_itself' }] });

    expect((await folders(invocation)).find((each) => each.id === a.id)?.parentId).toBeNull();
  });

  it(`nest at most ${String(MEDIA_FOLDER_MAX_DEPTH)} deep, counting what a moved folder holds`, async () => {
    const invocation = await inBusiness();
    let parentId: string | null = null;
    const chain: MediaFolder[] = [];
    for (let level = 1; level <= MEDIA_FOLDER_MAX_DEPTH; level += 1) {
      const made: MediaFolder = await folder(invocation, `Level ${String(level)}`, parentId);
      chain.push(made);
      parentId = made.id;
    }

    await expect(folder(invocation, 'Too deep', parentId)).rejects.toMatchObject({
      issues: [{ path: '/parentId', code: 'folder_too_deep' }],
    });
    // A folder with one inside it is two levels: it fits under level 3, not under level 4.
    const pair = await folder(invocation, 'Pair');
    await folder(invocation, 'Inner', pair.id);
    await expect(
      runCommand(
        services,
        media.folders.update,
        { id: pair.id, parentId: chain[3]?.id },
        invocation,
      ),
    ).rejects.toMatchObject({ issues: [{ code: 'folder_too_deep' }] });
    await runCommand(
      services,
      media.folders.update,
      { id: pair.id, parentId: chain[2]?.id },
      invocation,
    );
  });

  it('refuse a parent or a folder the business does not have', async () => {
    const invocation = await inBusiness();
    const unknown = toPublicId('media_folder', uuidv7());

    await expect(folder(invocation, 'Orphan', unknown)).rejects.toThrow(NotFoundError);
    await expect(
      runCommand(services, media.folders.update, { id: unknown, name: 'Ghost' }, invocation),
    ).rejects.toThrow(NotFoundError);
    await expect(
      runCommand(services, media.folders.remove, { id: unknown }, invocation),
    ).rejects.toThrow(NotFoundError);
    await expect(add(invocation, 'lost.png', png(), 'image/png', unknown)).rejects.toThrow(
      NotFoundError,
    );
    await expect(move(invocation, [(await add(invocation, 'a.png')).id], unknown)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('move what they hold to their parent when removed, and delete no file', async () => {
    const invocation = await inBusiness();
    const brand = await folder(invocation, 'Brand');
    const logos = await folder(invocation, 'Logos', brand.id);
    const old = await folder(invocation, 'Old', logos.id);
    // A folder inside may have the removed folder's own name.
    const twin = await folder(invocation, 'Logos', logos.id);
    const file = await add(invocation, 'mark.png', png(), 'image/png', logos.id);
    const deleted = await add(invocation, 'gone.png', png(), 'image/png', logos.id);
    await remove(invocation, deleted.id);
    const before = await stored();

    await runCommand(services, media.folders.remove, { id: logos.id }, invocation);

    expect(
      (await folders(invocation))
        .map(({ id, parentId }) => ({ id, parentId }))
        .sort((x, y) => x.id.localeCompare(y.id)),
    ).toEqual(
      [
        { id: brand.id, parentId: null },
        { id: old.id, parentId: brand.id },
        { id: twin.id, parentId: brand.id },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
    expect((await list(invocation, { folder: brand.id })).items.map((item) => item.id)).toEqual([
      file.id,
    ]);
    expect(await stored()).toBe(before);
  });

  it('are not removed when a folder inside would clash with a name at the destination', async () => {
    const invocation = await inBusiness();
    const brand = await folder(invocation, 'Brand');
    await folder(invocation, 'Archive');
    await folder(invocation, 'archive', brand.id);

    await expect(
      runCommand(services, media.folders.remove, { id: brand.id }, invocation),
    ).rejects.toThrow(ConflictError);

    expect(await folders(invocation)).toHaveLength(3);
  });
});

describe('moving files', () => {
  it('moves several at once, and back to the top', async () => {
    const invocation = await inBusiness();
    const made = await folder(invocation, 'Photos');
    const a = await add(invocation, 'a.png');
    const b = await add(invocation, 'b.png');
    const already = await add(invocation, 'c.png', png(), 'image/png', made.id);

    expect(await move(invocation, [a.id, b.id, already.id], made.id)).toEqual({ count: 2 });
    expect((await list(invocation, { folder: made.id })).items).toHaveLength(3);
    expect(await move(invocation, [a.id], null)).toEqual({ count: 1 });
    expect(names(await list(invocation, { folder: 'root' }))).toEqual(['a.png']);
  });

  it('moves all of them or none', async () => {
    const invocation = await inBusiness();
    const made = await folder(invocation, 'Photos');
    const a = await add(invocation, 'a.png');
    const outside = await files.upload(services, invocation, {
      body: Readable.from([png()]),
      contentType: 'image/png',
      filename: 'attachment.png',
    });

    // A file of the business that is not in the library is not the library's to move.
    await expect(move(invocation, [a.id, outside.id], made.id)).rejects.toThrow(NotFoundError);
    await expect(move(invocation, [a.id, toPublicId('file', uuidv7())], made.id)).rejects.toThrow(
      NotFoundError,
    );

    expect((await row(a.id)).folder_id).toBeNull();
    expect((await row(outside.id)).folder_id).toBeNull();
  });

  it.each([
    ['no file', []],
    ['the same file twice', ['same', 'same']],
    ['more than a hundred', Array.from({ length: 101 }, () => toPublicId('file', uuidv7()))],
  ])('refuses %s', async (_case, given) => {
    const invocation = await inBusiness();
    const file = await add(invocation, 'a.png');
    const ids = given.map((id) => (id === 'same' ? file.id : id));

    await expect(move(invocation, ids, null)).rejects.toThrow(ValidationError);
    await expect(remove(invocation, ...ids)).rejects.toThrow(ValidationError);
  });
});

describe('deleting', () => {
  it('removes the object from storage and the file from the library, for good', async () => {
    const invocation = await inBusiness();
    const file = await add(invocation, 'gone.png');
    const kept = await add(invocation, 'kept.png');
    const { publicUrl } = await update(invocation, file.id, { public: true });
    const { storage_key: key } = await row(file.id);
    const before = await stored();

    expect(await remove(invocation, file.id)).toEqual({ count: 1 });

    expect(await storage.get(key)).toBeUndefined();
    expect(await stored()).toBe(before - 1);
    expect(names(await list(invocation))).toEqual(['kept.png']);
    expect(await row(file.id)).toMatchObject({ public_key: null, folder_id: null });
    expect((await row(file.id)).deleted_at).toBeInstanceOf(Date);
    expect(await open(publicUrl ?? '')).toBeUndefined();
    await expect(media.read(services, invocation, file.id)).rejects.toThrow(NotFoundError);
    await expect(remove(invocation, file.id)).rejects.toThrow(NotFoundError);
    expect(await storage.get((await row(kept.id)).storage_key)).toBeDefined();
    expect(mediaUsage.parse(await media.usage(services, invocation))).toMatchObject({
      files: 1,
      bytes: kept.size,
      businessBytes: kept.size,
    });
  });

  it('refuses a file that is still used, naming where, and deletes none of the request', async () => {
    const invocation = await inBusiness();
    const logo = await add(invocation, 'logo.png');
    const other = await add(invocation, 'other.png');
    await database.as('crm_owner', (sql) =>
      sql.query('update tenancy.businesses set logo_file_id = $2 where id = $1', [
        invocation.context.businessId,
        uuid(logo.id),
      ]),
    );
    const before = await stored();

    await expect(remove(invocation, other.id, logo.id)).rejects.toEqual(
      new ConflictError('"logo.png" is still used by the business\'s logo. Remove it there first.'),
    );

    expect(await stored()).toBe(before);
    expect(names(await list(invocation, { sort: 'name_asc' }))).toEqual(['logo.png', 'other.png']);
    await database.as('crm_owner', (sql) =>
      sql.query('update tenancy.businesses set logo_file_id = null where id = $1', [
        invocation.context.businessId,
      ]),
    );
    expect(await remove(invocation, other.id, logo.id)).toEqual({ count: 2 });
  });

  it('changes nothing when storage refuses, so the file is there to delete again', async () => {
    const invocation = await inBusiness();
    const file = await add(invocation, 'stuck.png');
    const { publicUrl } = await update(invocation, file.id, { public: true });

    storageDown = true;
    try {
      await expect(remove(invocation, file.id)).rejects.toThrow('The storage service is down.');
    } finally {
      storageDown = false;
    }

    expect(names(await list(invocation))).toEqual(['stuck.png']);
    expect(await open(publicUrl ?? '')).toBeDefined();
    expect(await remove(invocation, file.id)).toEqual({ count: 1 });
  });

  it('deletes a file whose object is already gone', async () => {
    const invocation = await inBusiness();
    const file = await add(invocation, 'half.png');
    await storage.delete((await row(file.id)).storage_key);

    expect(await remove(invocation, file.id)).toEqual({ count: 1 });
    expect(names(await list(invocation))).toEqual([]);
  });

  it('is not for a file outside the library', async () => {
    const invocation = await inBusiness();
    const outside = await files.upload(services, invocation, {
      body: Readable.from([png()]),
      contentType: 'image/png',
      filename: 'attachment.png',
    });

    await expect(remove(invocation, outside.id)).rejects.toThrow(NotFoundError);
    await expect(update(invocation, outside.id, { public: true })).rejects.toThrow(NotFoundError);
    expect((await row(outside.id)).deleted_at).toBeNull();
  });
});

describe('a public address', () => {
  it('opens the file for anyone while it is public, and stops when it is private again', async () => {
    const invocation = await inBusiness();
    const body = png(4000);
    const file = await add(invocation, 'hero image.png', body);

    const published = await update(invocation, file.id, { public: true });
    const found = await open(published.publicUrl ?? '');

    expect(found).toMatchObject({
      filename: 'hero image.png',
      contentType: 'image/png',
      size: body.length,
      etag: `"${file.sha256}"`,
      inline: true,
    });
    expect(await read(await present(found).open())).toEqual(body);
    expect(await read(await present(found).open({ start: 10, end: 19 }))).toEqual(
      body.subarray(10, 20),
    );

    const again = await update(invocation, file.id, { public: true });
    expect(again.publicUrl).toBe(published.publicUrl);

    const hidden = await update(invocation, file.id, { public: false });
    expect(hidden).toMatchObject({ public: false, publicUrl: null });
    expect(await open(published.publicUrl ?? '')).toBeUndefined();

    // Public again is a new address: the old one stays dead.
    const republished = await update(invocation, file.id, { public: true });
    expect(republished.publicUrl).not.toBe(published.publicUrl);
    expect(await open(published.publicUrl ?? '')).toBeUndefined();
    expect(await open(republished.publicUrl ?? '')).toBeDefined();
  });

  it('downloads a document rather than showing it', async () => {
    const invocation = await inBusiness();
    const file = await add(invocation, 'menu.pdf', pdf(), 'application/pdf');
    const { publicUrl } = await update(invocation, file.id, { public: true });

    expect(await open(publicUrl ?? '')).toMatchObject({
      contentType: 'application/pdf',
      inline: false,
    });
  });

  it.each([
    ['a key nobody has', 'A'.repeat(22)],
    ['a key of the wrong shape', 'short'],
    ['a key with other characters', `${'A'.repeat(21)}'`],
    ['an empty key', ''],
  ])('opens nothing for %s', async (_case, key) => {
    expect(await media.findPublic(db, { key, correlationId: randomUUID() })).toBeUndefined();
  });

  it('opens nothing once the business is not active', async () => {
    const invocation = await inBusiness();
    const file = await add(invocation, 'a.png');
    const { publicUrl } = await update(invocation, file.id, { public: true });

    await database.as('crm_owner', (sql) =>
      sql.query("update tenancy.businesses set status = 'suspended' where id = $1", [
        invocation.context.businessId,
      ]),
    );

    expect(await open(publicUrl ?? '')).toBeUndefined();
  });

  it('says so when the stored bytes are missing', async () => {
    const invocation = await inBusiness();
    const file = await add(invocation, 'a.png');
    const { publicUrl } = await update(invocation, file.id, { public: true });
    await storage.delete((await row(file.id)).storage_key);

    const found = await open(publicUrl ?? '');

    await expect(present(found).open()).rejects.toThrow(
      `The bytes of file ${file.id} are missing.`,
    );
  });

  it('cannot be given where the install serves no public addresses', async () => {
    const invocation = await inBusiness();
    const file = await add(invocation, 'a.png');
    const closed = createMedia({
      storage,
      maxBytes: MAX_BYTES,
      linkSecret: LINK_SECRET,
      publicUrl: PUBLIC_URL,
      servesPublic: false,
    });

    await expect(
      runCommand(services, closed.commands.update, { id: file.id, public: true }, invocation),
    ).rejects.toMatchObject({ issues: [{ path: '/public', code: 'public_media_unavailable' }] });
    expect(mediaFileList.parse(await closed.list(services, invocation, {})).canPublish).toBe(false);
    // Renaming, and making private, still work there.
    await runCommand(services, closed.commands.update, { id: file.id, public: false }, invocation);
  });
});

describe('a preview address', () => {
  it('is given for what a browser shows, the same all hour, and opens the file', async () => {
    const invocation = await inBusiness();
    const body = png(1000);
    await add(invocation, 'a.png', body);
    await add(invocation, 'tour.mp4', mp4(), 'video/mp4');
    await add(invocation, 'jingle.mp3', mp3(), 'audio/mpeg');
    await add(invocation, 'menu.pdf', pdf(), 'application/pdf');
    await add(invocation, 'rows.csv', Buffer.from('a,b\n'), 'text/csv');

    const { items } = await list(invocation, { sort: 'name_asc' });
    const again = await list(invocation, { sort: 'name_asc' });

    expect(items.map((item) => [item.name, item.previewUrl !== null])).toEqual([
      ['a.png', true],
      ['jingle.mp3', true],
      ['menu.pdf', true],
      ['rows.csv', false],
      ['tour.mp4', true],
    ]);
    const [image] = items;
    expect(image?.previewUrl).toBe(again.items[0]?.previewUrl);
    expect(image?.previewUrl).toMatch(
      new RegExp(
        `^${PUBLIC_URL}/m/p/${image?.id ?? ''}\\?agency=.*&expires=${String(Date.parse('2026-10-12T22:00:00Z') / 1000)}&signature=`,
      ),
    );
    const found = await preview(image?.previewUrl ?? '');
    expect(found).toMatchObject({ contentType: 'image/png', size: body.length, inline: true });
    expect(await read(await (found as FoundMedia).open())).toEqual(body);
  });

  it('expires, and cannot be altered or used for another file', async () => {
    const invocation = await inBusiness();
    await add(invocation, 'a.png');
    await add(invocation, 'b.png');
    const [a, b] = (await list(invocation, { sort: 'name_asc' })).items;
    const address = new URL(a?.previewUrl ?? '');

    expect(await preview(address.href, new Date('2026-10-12T21:59:59.000Z'))).toMatchObject({
      filename: 'a.png',
    });
    expect(await preview(address.href, new Date('2026-10-12T22:00:00.000Z'))).toEqual({
      refused: 'expired',
    });
    const other = new URL(address);
    other.pathname = `/m/p/${b?.id ?? ''}`;
    expect(await preview(other.href)).toEqual({ refused: 'invalid' });
    const longer = new URL(address);
    longer.searchParams.set('expires', '1999999999');
    expect(await preview(longer.href)).toEqual({ refused: 'invalid' });
    expect(await preview(`${PUBLIC_URL}/m/p/file_nope?${address.searchParams.toString()}`)).toEqual(
      {
        refused: 'not_found',
      },
    );
  });

  it('opens only a live library file of a type a browser shows', async () => {
    const invocation = await inBusiness();
    const context = invocation.context;
    const signed = async (file: StoredFile) => {
      const link = await files.link(services, invocation, file.id, { seconds: 600, now: NOW });
      return `${PUBLIC_URL}/m/p/${file.id}?${link.path.split('?')[1] ?? ''}`;
    };
    const outside = await files.upload(services, invocation, {
      body: Readable.from([png()]),
      contentType: 'image/png',
      filename: 'attachment.png',
    });
    const text = await add(invocation, 'notes.txt', Buffer.from('notes'), 'text/plain');
    const gone = await add(invocation, 'gone.png');
    const goneAddress = await signed(gone);
    await remove(invocation, gone.id);

    // A genuine file link, to a file that is not the library's: the link route serves it,
    // this one does not.
    expect(await preview(await signed(outside))).toEqual({ refused: 'not_found' });
    expect(await preview(await signed(text))).toEqual({ refused: 'not_found' });
    expect(await preview(goneAddress)).toEqual({ refused: 'not_found' });
    expect(context.businessId).toBeDefined();
  });
});

describe('the quota', () => {
  it('refuses an upload that would take the business past it, and stores nothing', async () => {
    const invocation = await inBusiness();
    const limited = createFiles({
      storage,
      uploadDirectory: join(root, 'uploads'),
      maxBytes: MAX_BYTES,
      linkSecret: LINK_SECRET,
      businessQuotaBytes: 1000,
    });
    const put = (body: Buffer, library: boolean) =>
      limited.upload(services, invocation, {
        body: Readable.from([body]),
        contentType: 'text/plain',
        filename: 'a.txt',
        ...(library ? { library: { folderId: null } } : {}),
      });
    await put(Buffer.alloc(600, 0x20), true);
    const before = await stored();

    // Every file of the business counts, in the library or not.
    for (const library of [true, false])
      await expect(put(Buffer.alloc(401, 0x20), library)).rejects.toEqual(
        new ValidationError([
          {
            path: '',
            code: 'storage_full',
            message:
              "This business's storage is full: it holds 600 of 1000 bytes. Delete files to make room.",
          },
        ]),
      );
    expect(await stored()).toBe(before);

    const fits = await put(Buffer.alloc(400, 0x20), false);
    expect(fits.size).toBe(400);
    const told = createMedia({
      storage,
      maxBytes: MAX_BYTES,
      linkSecret: LINK_SECRET,
      businessQuotaBytes: 1000,
      publicUrl: PUBLIC_URL,
      servesPublic: true,
    });
    expect(mediaUsage.parse(await told.usage(services, invocation))).toMatchObject({
      businessBytes: 1000,
      quotaBytes: 1000,
    });
  });

  it('makes room again when a file is deleted, and does not count the agency or its other businesses', async () => {
    const invocation = await inBusiness();
    const sibling = await database.fixtures.business(invocation.context.agencyId);
    const { businessId: _business, ...agencyOnly } = invocation.context;
    const limited = createFiles({
      storage,
      uploadDirectory: join(root, 'uploads'),
      maxBytes: MAX_BYTES,
      linkSecret: LINK_SECRET,
      businessQuotaBytes: 500,
    });
    const put = (who: Invocation, library = true) =>
      limited.upload(services, who, {
        body: Readable.from([Buffer.alloc(400, 0x20)]),
        contentType: 'text/plain',
        filename: 'a.txt',
        ...(library ? { library: { folderId: null } } : {}),
      });

    const first = await put(invocation);
    await put({ ...invocation, context: { ...invocation.context, businessId: sibling.id } });
    // The agency's own files are no business's.
    await put({ ...invocation, context: agencyOnly }, false);
    await put({ ...invocation, context: agencyOnly }, false);
    await expect(put(invocation)).rejects.toMatchObject({ issues: [{ code: 'storage_full' }] });

    await remove(invocation, first.id);

    expect((await put(invocation)).size).toBe(400);
  });
});
