// The media library's API routes, as the server runs them: parameters, query and body
// arrive unparsed, and each answer has its contract's shape.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import {
  mediaBulkResult,
  mediaEndpoints,
  mediaFile,
  mediaFileDetail,
  mediaFileList,
  mediaFolder,
  mediaFolderList,
  mediaUsage,
  storedFile,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { NotFoundError, ValidationError } from '@repo/kernel';
import { localStorage } from '@repo/storage';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFiles, createMedia, fileRoutes, mediaRoutes } from './index.js';

const MAX_BYTES = 4096;
const PUBLIC_URL = 'https://crm.example.test';
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

let database: TestDatabase;
let db: Database;
let services: Services;
let root: string;
let routes: readonly ApiRoute[];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  root = await mkdtemp(join(tmpdir(), 'crm-media-routes-'));
  const options = {
    storage: localStorage({ directory: join(root, 'storage') }),
    uploadDirectory: join(root, 'uploads'),
    maxBytes: MAX_BYTES,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
  };
  routes = [
    ...fileRoutes(createFiles(options), { apiUrl: `${PUBLIC_URL}/api/v1` }),
    ...mediaRoutes(createMedia({ ...options, publicUrl: PUBLIC_URL, servesPublic: true })),
  ];
});

afterAll(async () => {
  await db.destroy();
  await database.close();
  await rm(root, { recursive: true, force: true });
});

// Async, so a refusal made before the first await is a rejection like any other.
async function run(
  invocation: Invocation,
  operationId: string,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
) {
  const found = routes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) throw new Error(`No route for ${operationId}.`);
  return await found.run(
    { invocation, params: request.params ?? {}, query: request.query ?? {}, body: request.body },
    services,
  );
}

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

const upload = async (invocation: Invocation, query: Record<string, string>) =>
  storedFile.parse(
    await run(invocation, 'uploadFile', {
      query,
      body: { stream: Readable.from([png]), contentType: 'image/png', contentLength: png.length },
    }),
  );

it('serves every operation the contract names, each command with its route', () => {
  const served = routes.map((each) => each.endpoint.operationId);
  for (const endpoint of mediaEndpoints) expect(served).toContain(endpoint.operationId);
  expect(
    routes
      .filter((each) => each.command !== undefined)
      .map((each) => each.command?.name)
      .sort(),
  ).toEqual([
    'file.create',
    'media.create_folder',
    'media.delete',
    'media.move',
    'media.remove_folder',
    'media.update',
    'media.update_folder',
  ]);
});

describe('the library over HTTP', () => {
  it('uploads into a folder, lists, reads, renames, publishes, moves and deletes', async () => {
    const invocation = await inBusiness();
    const made = mediaFolder.parse(
      await run(invocation, 'createMediaFolder', { body: { name: 'Photos' } }),
    );
    const file = await upload(invocation, {
      filename: 'front.png',
      library: 'true',
      folder: made.id,
    });
    await upload(invocation, { filename: 'attachment.png' });

    const page = mediaFileList.parse(
      // A query arrives as text: the limit is a string here.
      await run(invocation, 'listMedia', { query: { folder: made.id, limit: '10' } }),
    );
    expect(page.items.map((item) => item.id)).toEqual([file.id]);
    expect(mediaFileList.parse(await run(invocation, 'listMedia')).items).toHaveLength(1);

    const detail = mediaFileDetail.parse(
      await run(invocation, 'getMediaFile', { params: { id: file.id } }),
    );
    expect(detail).toMatchObject({ name: 'front.png', folderId: made.id, usedIn: [] });

    const changed = mediaFile.parse(
      await run(invocation, 'updateMediaFile', {
        params: { id: file.id },
        body: { name: 'Shop front.png', public: true },
      }),
    );
    expect(changed.publicUrl).toMatch(
      new RegExp(`^${PUBLIC_URL}/m/[A-Za-z0-9_-]{22}/Shop%20front\\.png$`),
    );

    expect(
      mediaBulkResult.parse(
        await run(invocation, 'moveMedia', { body: { ids: [file.id], folderId: null } }),
      ),
    ).toEqual({ count: 1 });
    expect(mediaUsage.parse(await run(invocation, 'getMediaUsage'))).toMatchObject({
      files: 1,
      bytes: png.length,
      businessBytes: png.length * 2,
      maxFileBytes: MAX_BYTES,
    });

    const renamed = mediaFolder.parse(
      await run(invocation, 'updateMediaFolder', {
        params: { id: made.id },
        body: { name: 'Pictures' },
      }),
    );
    expect(renamed.name).toBe('Pictures');
    expect(mediaFolderList.parse(await run(invocation, 'listMediaFolders')).items).toHaveLength(1);
    expect(await run(invocation, 'removeMediaFolder', { params: { id: made.id } })).toBeUndefined();
    expect(mediaFolderList.parse(await run(invocation, 'listMediaFolders')).items).toEqual([]);

    expect(
      mediaBulkResult.parse(await run(invocation, 'deleteMedia', { body: { ids: [file.id] } })),
    ).toEqual({ count: 1 });
    await expect(run(invocation, 'getMediaFile', { params: { id: file.id } })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('refuses a folder for an upload that is not for the library', async () => {
    const invocation = await inBusiness();
    const made = mediaFolder.parse(
      await run(invocation, 'createMediaFolder', { body: { name: 'Photos' } }),
    );

    await expect(upload(invocation, { filename: 'a.png', folder: made.id })).rejects.toMatchObject({
      issues: [{ path: '/folder', code: 'library_required' }],
    });
    await expect(upload(invocation, { filename: 'a.png', library: 'yes' })).rejects.toThrow(
      ValidationError,
    );
  });

  it.each([
    ['a limit over a hundred', 'listMedia', { query: { limit: '101' } }],
    ['a sort nobody offers', 'listMedia', { query: { sort: 'random' } }],
    ['a type group nobody offers', 'listMedia', { query: { kind: 'archive' } }],
    ['a folder that is not a folder id', 'listMedia', { query: { folder: 'top' } }],
    ['a query it does not know', 'listMedia', { query: { deleted: 'true' } }],
    [
      'a file id that is not one',
      'getMediaFile',
      { params: { id: 'tag_01h455vb4pex5vsknk084sn02q' } },
    ],
    ['a rename with nothing in it', 'updateMediaFile', { params: { id: 'x' }, body: {} }],
    ['a folder without a name', 'createMediaFolder', { body: { name: ' ' } }],
    ['a folder name over 120 characters', 'createMediaFolder', { body: { name: 'a'.repeat(121) } }],
    ['a folder name with a line break', 'createMediaFolder', { body: { name: 'a\nb' } }],
    ['a folder change with nothing in it', 'updateMediaFolder', { params: { id: 'x' }, body: {} }],
    ['a move without a destination', 'moveMedia', { body: { ids: [] } }],
    ['a delete of nothing', 'deleteMedia', { body: { ids: [] } }],
  ])('refuses %s', async (_case, operationId, request) => {
    await expect(run(await inBusiness(), operationId, request)).rejects.toThrow(ValidationError);
  });
});
