// Media Storage over HTTP, against a migrated Postgres and local storage: the library's API
// as the dashboard calls it, and the two addresses nobody signs in to open.
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowEveryone, type Services } from '@repo/commands';
import {
  mediaFile,
  mediaFileList,
  mediaFolder,
  mediaUsage,
  storedFile,
  type MediaFile,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  createFiles,
  createMedia,
  fileRoutes,
  mediaRoutes,
  type Files,
  type Media,
} from '@repo/module-files';
import { localStorage } from '@repo/storage';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { apiRoutes } from './api-routes.js';
import type { Config, DevTenantContext } from './config.js';
import { API_PREFIX, buildServer, type Server } from './server.js';

const MAX_BYTES = 8192;
const PUBLIC_URL = 'https://crm.example.test';
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(600),
]);
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from('ftypisom'),
  randomBytes(2000),
]);

let database: TestDatabase;
let db: Database;
let services: Services;
let root: string;
let files: Files;
let media: Media;
const servers: Server[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  root = await mkdtemp(join(tmpdir(), 'crm-media-http-'));
  const options = {
    storage: localStorage({ directory: join(root, 'storage') }),
    uploadDirectory: join(root, 'uploads'),
    maxBytes: MAX_BYTES,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
  };
  files = createFiles(options);
  media = createMedia({ ...options, publicUrl: PUBLIC_URL, servesPublic: true });
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close(1000)));
  await db.destroy();
  await database.close();
  await rm(root, { recursive: true, force: true });
});

/** The API, listening, signed in as this context (or no one), with files and media. */
async function apiFor(signedIn: DevTenantContext | undefined): Promise<string> {
  const config: Config = {
    nodeEnv: 'test',
    role: 'app',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseAppUrl: database.url('crm_app'),
    databaseWorkerUrl: undefined,
    databasePoolSize: 2,
    shutdownTimeoutMs: 1000,
    dashboardDir: undefined,
    devTenantContext: signedIn,
    publicUrl: PUBLIC_URL,
    authentication: undefined,
    trustProxy: [],
    files: undefined,
    vault: undefined,
    mail: undefined,
  };
  const server = await buildServer({
    config,
    logger: pino({ level: 'silent' }),
    serveApi: true,
    routes: [
      ...apiRoutes(),
      ...fileRoutes(files, { apiUrl: `${PUBLIC_URL}${API_PREFIX}` }),
      ...mediaRoutes(media),
    ],
    services,
    files,
    publicMedia: { media, db, rateLimit: () => Promise.resolve({ allowed: true }) },
    readinessChecks: {},
  });
  servers.push(server);
  return server.app.listen({ host: '127.0.0.1', port: 0 });
}

async function signedInToBusiness(): Promise<DevTenantContext> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  return { agencyId: agency.id, businessId: business.id, userId: user.id };
}

const stored = async () =>
  (await readdir(join(root, 'storage'), { recursive: true, withFileTypes: true })).filter(
    (entry) => entry.isFile() && !entry.parentPath.includes('.tmp'),
  ).length;

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});

async function add(
  api: string,
  filename: string,
  body: Buffer = png,
  type = 'image/png',
  folder?: string,
): Promise<Response> {
  const query = new URLSearchParams({ filename, library: 'true' });
  if (folder !== undefined) query.set('folder', folder);
  return fetch(`${api}${API_PREFIX}/files?${query.toString()}`, {
    method: 'POST',
    headers: { 'content-type': type },
    body: new Uint8Array(body),
  });
}

async function listed(api: string, query = ''): Promise<MediaFile[]> {
  const response = await fetch(`${api}${API_PREFIX}/media${query}`);
  expect(response.status).toBe(200);
  return mediaFileList.parse(await response.json()).items;
}

/** An address the API gave, sent to the server under test instead of the public one. */
const at = (api: string, url: string | null) => (url ?? '').replace(PUBLIC_URL, api);

describe('media storage over HTTP', () => {
  it('uploads into a folder, lists, renames, moves, counts and deletes', async () => {
    const api = await apiFor(await signedInToBusiness());
    const folderResponse = await fetch(
      `${api}${API_PREFIX}/media-folders`,
      json('POST', { name: 'Photos' }),
    );
    expect(folderResponse.status).toBe(201);
    const folder = mediaFolder.parse(await folderResponse.json());

    const first = await add(api, 'front.png', png, 'image/png', folder.id);
    const second = await add(api, 'tour.mp4', mp4, 'video/mp4');
    expect([first.status, second.status]).toEqual([201, 201]);
    const file = storedFile.parse(await first.json());

    expect((await listed(api, `?folder=${folder.id}`)).map((item) => item.name)).toEqual([
      'front.png',
    ]);
    expect((await listed(api, '?folder=root&kind=video')).map((item) => item.name)).toEqual([
      'tour.mp4',
    ]);
    expect((await listed(api, '?search=FRONT&sort=name_asc&limit=5')).length).toBe(1);

    const renamed = await fetch(
      `${api}${API_PREFIX}/media/${file.id}`,
      json('PATCH', { name: 'Shop front.png' }),
    );
    expect(renamed.status).toBe(200);
    expect(mediaFile.parse(await renamed.json()).name).toBe('Shop front.png');

    const moved = await fetch(
      `${api}${API_PREFIX}/media/move`,
      json('POST', { ids: [file.id], folderId: null }),
    );
    expect([moved.status, await moved.json()]).toEqual([200, { count: 1 }]);

    const usage = await fetch(`${api}${API_PREFIX}/media/usage`);
    expect(mediaUsage.parse(await usage.json())).toMatchObject({
      files: 2,
      bytes: png.length + mp4.length,
      quotaBytes: null,
      maxFileBytes: MAX_BYTES,
    });

    const removedFolder = await fetch(`${api}${API_PREFIX}/media-folders/${folder.id}`, {
      method: 'DELETE',
    });
    expect(removedFolder.status).toBe(204);

    const before = await stored();
    const deleted = await fetch(
      `${api}${API_PREFIX}/media/delete`,
      json('POST', { ids: [file.id] }),
    );
    expect([deleted.status, await deleted.json()]).toEqual([200, { count: 1 }]);
    expect(await stored()).toBe(before - 1);
    expect((await fetch(`${api}${API_PREFIX}/media/${file.id}`)).status).toBe(404);
  });

  it('answers each refusal with its own status', async () => {
    const signedIn = await signedInToBusiness();
    const api = await apiFor(signedIn);
    const file = storedFile.parse(await (await add(api, 'logo.png')).json());

    const tooLarge = await add(api, 'big.txt', Buffer.alloc(MAX_BYTES + 1, 0x20), 'text/plain');
    expect(tooLarge.status).toBe(413);
    const wrongType = await add(api, 'page.svg', Buffer.from('<svg/>'), 'image/svg+xml');
    expect(wrongType.status).toBe(422);
    const disguised = await add(api, 'video.mp4', png, 'video/mp4');
    expect(disguised.status).toBe(422);
    expect(await disguised.json()).toMatchObject({
      errors: [{ code: 'type_mismatch' }],
    });

    const sameName = await fetch(`${api}${API_PREFIX}/media-folders`, json('POST', { name: 'A' }));
    expect(sameName.status).toBe(201);
    const clash = await fetch(`${api}${API_PREFIX}/media-folders`, json('POST', { name: 'a' }));
    expect(clash.status).toBe(409);

    await database.as('crm_owner', (sql) =>
      sql.query(
        `update tenancy.businesses set logo_file_id = (
           select id from files.files where business_id = $1 and filename = 'logo.png')
         where id = $1`,
        [signedIn.businessId],
      ),
    );
    const used = await fetch(`${api}${API_PREFIX}/media/delete`, json('POST', { ids: [file.id] }));
    expect(used.status).toBe(409);
    expect(await used.json()).toMatchObject({
      detail: '"logo.png" is still used by the business\'s logo. Remove it there first.',
    });

    const anonymous = await apiFor(undefined);
    expect((await fetch(`${anonymous}${API_PREFIX}/media`)).status).toBe(401);
    expect((await add(anonymous, 'no.png')).status).toBe(401);
  });

  it('keeps one business out of another', async () => {
    const mine = await apiFor(await signedInToBusiness());
    const theirs = await apiFor(await signedInToBusiness());
    const file = storedFile.parse(await (await add(mine, 'mine.png')).json());

    expect(await listed(theirs)).toEqual([]);
    expect((await fetch(`${theirs}${API_PREFIX}/media/${file.id}`)).status).toBe(404);
    const renamed = await fetch(
      `${theirs}${API_PREFIX}/media/${file.id}`,
      json('PATCH', { name: 'taken.png' }),
    );
    expect(renamed.status).toBe(404);
    const deleted = await fetch(
      `${theirs}${API_PREFIX}/media/delete`,
      json('POST', { ids: [file.id] }),
    );
    expect(deleted.status).toBe(404);
    expect((await listed(mine)).map((item) => item.name)).toEqual(['mine.png']);
  });
});

describe('a public media address over HTTP', () => {
  it('serves a public file to anyone, with headers a cache may keep, and only while it is public', async () => {
    const api = await apiFor(await signedInToBusiness());
    const anonymous = await apiFor(undefined);
    const file = storedFile.parse(await (await add(api, 'hero image.png')).json());
    const [listedFile] = await listed(api);
    expect(listedFile).toMatchObject({ public: false, publicUrl: null });

    const published = mediaFile.parse(
      await (
        await fetch(`${api}${API_PREFIX}/media/${file.id}`, json('PATCH', { public: true }))
      ).json(),
    );
    expect(published.publicUrl).toMatch(
      new RegExp(`^${PUBLIC_URL}/m/[A-Za-z0-9_-]{22}/hero%20image\\.png$`),
    );

    const response = await fetch(at(anonymous, published.publicUrl));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(png.length),
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${file.sha256}"`,
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'cross-origin',
    });
    expect(response.headers.get('content-disposition')).toMatch(/^inline; /);
    expect(response.headers.get('set-cookie')).toBeNull();

    // Any name after the key finds it; the key alone is the address.
    const otherName = at(anonymous, published.publicUrl).replace('hero%20image.png', 'x.png');
    expect((await fetch(otherName)).status).toBe(200);

    const held = await fetch(at(anonymous, published.publicUrl), {
      headers: { 'if-none-match': `"${file.sha256}"` },
    });
    expect(held.status).toBe(304);

    const part = await fetch(at(anonymous, published.publicUrl), {
      headers: { range: 'bytes=8-15' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 8-15/${String(png.length)}`);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(png.subarray(8, 16));

    await fetch(`${api}${API_PREFIX}/media/${file.id}`, json('PATCH', { public: false }));
    const hidden = await fetch(at(anonymous, published.publicUrl));
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get('cache-control')).toBe('no-store');
    expect(await hidden.text()).toBe('There is no such file.');
  });

  it('serves nothing for a private file, a deleted one, or a key nobody has', async () => {
    const api = await apiFor(await signedInToBusiness());
    const anonymous = await apiFor(undefined);
    const file = storedFile.parse(await (await add(api, 'a.png')).json());
    const { publicUrl } = mediaFile.parse(
      await (
        await fetch(`${api}${API_PREFIX}/media/${file.id}`, json('PATCH', { public: true }))
      ).json(),
    );
    await fetch(`${api}${API_PREFIX}/media/delete`, json('POST', { ids: [file.id] }));

    for (const url of [
      at(anonymous, publicUrl),
      `${anonymous}/m/${'A'.repeat(22)}/a.png`,
      `${anonymous}/m/short/a.png`,
      // A file's id is not its address.
      `${anonymous}/m/${file.id}/a.png`,
    ])
      expect((await fetch(url)).status, url).toBe(404);
  });
});

describe('a preview address over HTTP', () => {
  it('shows a library file without signing in, for the browser to keep privately', async () => {
    const api = await apiFor(await signedInToBusiness());
    const anonymous = await apiFor(undefined);
    await add(api, 'tour.mp4', mp4, 'video/mp4');
    const [video] = await listed(api);
    expect(video?.previewUrl).toMatch(new RegExp(`^${PUBLIC_URL}/m/p/${video?.id ?? ''}\\?`));

    const response = await fetch(at(anonymous, video?.previewUrl ?? null));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(mp4);
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(response.headers.get('content-type')).toBe('video/mp4');

    const seek = await fetch(at(anonymous, video?.previewUrl ?? null), {
      headers: { range: 'bytes=1000-' },
    });
    expect(seek.status).toBe(206);
    expect(Buffer.from(await seek.arrayBuffer())).toEqual(mp4.subarray(1000));

    const altered = new URL(at(anonymous, video?.previewUrl ?? null));
    altered.searchParams.set('expires', '1999999999');
    const refused = await fetch(altered);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe('This link is not valid any more.');
  });
});
