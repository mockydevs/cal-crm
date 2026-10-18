// Files over HTTP, against a migrated Postgres and local storage: a file from another
// business can't be fetched, even with its link after the link expires, and uploads over
// the limit are refused before they're stored.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowEveryone, type Services } from '@repo/commands';
import { fileLink, storedFile, type StoredFile } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { createFiles, fileRoutes, type Files } from '@repo/module-files';
import { localStorage } from '@repo/storage';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { apiRoutes } from './api-routes.js';
import type { Config, DevTenantContext } from './config.js';
import { API_PREFIX, buildServer, type Server } from './server.js';

const MAX_BYTES = 1024;
// Links name this address; the tests send them to wherever the server listens.
const PUBLIC_URL = 'https://crm.example.test';
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(200),
]);

let database: TestDatabase;
let db: Database;
let services: Services;
let root: string;
let files: Files;
const servers: Server[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  root = await mkdtemp(join(tmpdir(), 'crm-files-http-'));
  files = createFiles({
    storage: localStorage({ directory: join(root, 'storage') }),
    uploadDirectory: join(root, 'uploads'),
    maxBytes: MAX_BYTES,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
  });
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close(1000)));
  await db.destroy();
  await database.close();
  await rm(root, { recursive: true, force: true });
});

/** The API, listening, signed in as this context (or no one), with the files service. */
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
    routes: [...apiRoutes(), ...fileRoutes(files, { apiUrl: `${PUBLIC_URL}${API_PREFIX}` })],
    services,
    files,
    readinessChecks: {},
  });
  servers.push(server);
  return server.app.listen({ host: '127.0.0.1', port: 0 });
}

/** A user signed in to a new business of a new agency. */
async function signedInToBusiness(): Promise<{
  agencyId: string;
  businessId: string;
  userId: string;
}> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  return { agencyId: agency.id, businessId: business.id, userId: user.id };
}

const stored = async () =>
  (await readdir(join(root, 'storage'), { recursive: true, withFileTypes: true })).filter(
    (entry) => entry.isFile() && !entry.parentPath.includes('.tmp'),
  ).length;

function upload(
  api: string,
  body: NonNullable<RequestInit['body']>,
  type = 'image/png',
): Promise<Response> {
  return fetch(`${api}${API_PREFIX}/files?filename=logo.png`, {
    method: 'POST',
    headers: { 'content-type': type },
    body,
  });
}

async function uploaded(api: string): Promise<StoredFile> {
  const response = await upload(api, png);
  expect(response.status).toBe(201);
  return storedFile.parse(await response.json());
}

async function linkTo(api: string, file: StoredFile, expiresIn?: number): Promise<string> {
  const response = await fetch(`${api}${API_PREFIX}/files/${file.id}/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(expiresIn === undefined ? {} : { expiresIn }),
  });
  expect(response.status).toBe(201);
  return fileLink.parse(await response.json()).url;
}

/** A link's URL, sent to the server under test instead of the public address. */
const at = (api: string, url: string) => url.replace(PUBLIC_URL, api);

describe('files over HTTP', () => {
  it('uploads a file, links to it, and opens the link without signing in', async () => {
    const api = await apiFor(await signedInToBusiness());
    const file = await uploaded(api);
    const url = await linkTo(api, file);
    expect(url.startsWith(`${PUBLIC_URL}${API_PREFIX}/files/${file.id}/content?`)).toBe(true);

    const anonymous = await apiFor(undefined);
    const response = await fetch(at(anonymous, url));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toMatch(/^inline; /);
  });

  it('refuses an upload whose stated length is over the limit, before storing anything', async () => {
    const api = await apiFor(await signedInToBusiness());
    const before = await stored();

    const response = await upload(api, new Uint8Array(MAX_BYTES + 1), 'text/plain');

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      detail: `Send at most ${String(MAX_BYTES)} bytes.`,
    });
    expect(await stored()).toBe(before);
  });

  it('refuses a streamed upload once it passes the limit, before storing anything', async () => {
    const api = await apiFor(await signedInToBusiness());
    const before = await stored();
    // No Content-Length: the body arrives in chunks, and the limit is counted.
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent <= MAX_BYTES; sent += 256) controller.enqueue(new Uint8Array(256));
        controller.close();
      },
    });

    const response = await fetch(`${api}${API_PREFIX}/files?filename=big.txt`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: chunks,
      duplex: 'half',
    });

    expect(response.status).toBe(413);
    expect(await stored()).toBe(before);
  });

  it('refuses an upload from someone not signed in', async () => {
    const before = await stored();

    const response = await upload(await apiFor(undefined), png);

    expect(response.status).toBe(401);
    expect(await stored()).toBe(before);
  });

  it("won't link to another business's file", async () => {
    const file = await uploaded(await apiFor(await signedInToBusiness()));
    const other = await apiFor(await signedInToBusiness());

    const response = await fetch(`${other}${API_PREFIX}/files/${file.id}/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(404);
  });

  it("won't open another business's file with a link to one of our own", async () => {
    const ours = await apiFor(await signedInToBusiness());
    const theirs = await uploaded(await apiFor(await signedInToBusiness()));
    const url = await linkTo(ours, await uploaded(ours));

    const response = await fetch(
      at(ours, url.replace(/files\/[^/]+\/content/, `files/${theirs.id}/content`)),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ detail: "This link isn't valid." });
  });

  it('refuses a link once it has expired', async () => {
    const signedIn = await signedInToBusiness();
    const api = await apiFor(signedIn);
    const file = await uploaded(api);
    const expired = await files.link(
      services,
      {
        context: {
          ...signedIn,
          actorKind: 'user',
          actorId: signedIn.userId,
          correlationId: randomUUID(),
        },
        permissions: 'all',
      },
      file.id,
      { seconds: 1, now: new Date(Date.now() - 60_000) },
    );

    const response = await fetch(`${api}${API_PREFIX}${expired.path}`);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ detail: 'This link has expired.' });
  });
});
