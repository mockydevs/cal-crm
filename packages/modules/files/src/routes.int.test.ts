// The files module's API routes, as the server runs them: an upload's body arrives unread.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import { fileLink, storedFile } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ContentTooLargeError, NotFoundError, ValidationError } from '@repo/kernel';
import { localStorage } from '@repo/storage';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFiles, fileRoutes, type Files } from './index.js';

const MAX_BYTES = 1024;
const API_URL = 'https://crm.example.test/api/v1';
const text = Buffer.from('name,email\nDana,dana@example.com\n');

let database: TestDatabase;
let db: Database;
let services: Services;
let root: string;
let files: Files;
let routes: readonly ApiRoute[];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  root = await mkdtemp(join(tmpdir(), 'crm-file-routes-'));
  files = createFiles({
    storage: localStorage({ directory: join(root, 'storage') }),
    uploadDirectory: join(root, 'uploads'),
    maxBytes: MAX_BYTES,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
  });
  routes = fileRoutes(files, { apiUrl: API_URL });
});

afterAll(async () => {
  await db.destroy();
  await database.close();
  await rm(root, { recursive: true, force: true });
});

function route(operationId: string): ApiRoute {
  const found = routes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) throw new Error(`No route for ${operationId}.`);
  return found;
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

function upload(
  invocation: Invocation,
  stream: Readable,
  options: { query?: unknown; contentType?: string; contentLength?: number } = {},
) {
  return route('uploadFile').run(
    {
      invocation,
      params: {},
      query: options.query ?? { filename: 'contacts.csv' },
      body: {
        stream,
        contentType: options.contentType ?? 'text/csv',
        contentLength: options.contentLength,
      },
    },
    services,
  );
}

const createLink = (invocation: Invocation, id: string, body: unknown) =>
  route('createFileLink').run({ invocation, params: { id }, query: {}, body }, services);

describe('POST /files (uploadFile)', () => {
  it("stores the request's body as a file, in the contract's shape", async () => {
    const file = storedFile.parse(await upload(await inBusiness(), Readable.from([text])));

    expect(file).toMatchObject({
      filename: 'contacts.csv',
      contentType: 'text/csv',
      size: text.length,
    });
  });

  it('refuses a stated length over the limit without reading the body', async () => {
    let read = false;
    const body = new Readable({
      read() {
        read = true;
        this.push(randomBytes(64));
      },
    });

    await expect(
      upload(await inBusiness(), body, { contentLength: MAX_BYTES + 1 }),
    ).rejects.toBeInstanceOf(ContentTooLargeError);
    expect(read).toBe(false);
  });

  it('refuses a body over the limit that stated no length', async () => {
    await expect(
      upload(await inBusiness(), Readable.from([Buffer.alloc(MAX_BYTES + 1, 0x41)])),
    ).rejects.toBeInstanceOf(ContentTooLargeError);
  });

  it('wants a file name', async () => {
    await expect(upload(await inBusiness(), Readable.from([text]), { query: {} })).rejects.toEqual(
      expect.objectContaining({ issues: [expect.objectContaining({ path: '/filename' })] }),
    );
  });

  it('fails loudly without the body unread, which only a server bug would cause', async () => {
    await expect(
      route('uploadFile').run(
        { invocation: await inBusiness(), params: {}, query: { filename: 'a.csv' }, body: '{}' },
        services,
      ),
    ).rejects.toThrow('uploadFile takes the request body unread');
  });
});

describe('POST /files/{id}/links (createFileLink)', () => {
  it('answers with a link under the API that opens the file, for an hour by default', async () => {
    const invocation = await inBusiness();
    const file = storedFile.parse(await upload(invocation, Readable.from([text])));
    const before = Date.now();

    const link = fileLink.parse(await createLink(invocation, file.id, {}));
    const after = Date.now();

    const url = new URL(link.url);
    expect(url.href.startsWith(`${API_URL}/files/${file.id}/content?`)).toBe(true);
    // An hour from the second the link was signed in, which lies between the two readings.
    expect(Date.parse(link.expiresAt)).toBeGreaterThan(before + 3599_000);
    expect(Date.parse(link.expiresAt)).toBeLessThanOrEqual(after + 3600_000);
    const opened = await files.open(db, {
      fileId: file.id,
      query: Object.fromEntries(url.searchParams),
      now: new Date(),
      correlationId: randomUUID(),
    });
    if (!('body' in opened)) throw new Error(`Refused: ${opened.refused}`);
    opened.body.destroy();
    expect(opened.filename).toBe('contacts.csv');
  });

  it('takes a lifetime of up to seven days', async () => {
    const invocation = await inBusiness();
    const file = storedFile.parse(await upload(invocation, Readable.from([text])));

    await expect(createLink(invocation, file.id, { expiresIn: 604_800 })).resolves.toBeDefined();
    await expect(createLink(invocation, file.id, { expiresIn: 604_801 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("can't link to another business's file", async () => {
    const file = storedFile.parse(await upload(await inBusiness(), Readable.from([text])));

    await expect(createLink(await inBusiness(), file.id, {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses an id that is not a file id', async () => {
    await expect(
      createLink(await inBusiness(), 'tag_01h455vb4pex5vsknk084sn02q', {}),
    ).rejects.toEqual(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ path: '/id' })]) as unknown,
      }),
    );
  });
});
