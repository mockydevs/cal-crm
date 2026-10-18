// A record's files and the two field types that came with them (a text box list and a file
// upload field), through the actual Fastify composition, the real files service on local
// storage and a migrated Postgres: an upload is checked by its bytes, counted against its
// field, listed in the Documents panel with the conversation's attachments, opened through
// a short-lived link only the record's readers get, and deleted for good.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowEveryone } from '@repo/commands';
import {
  fieldDefinition,
  fileLink,
  recordField,
  recordFile,
  recordFields,
  recordFilesPage,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import { createFiles, fileRoutes, type Files } from '@repo/module-files';
import { localStorage, type Storage } from '@repo/storage';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { apiRoutes } from './api-routes.js';
import type { Config, DevTenantContext } from './config.js';
import { buildServer, type Server } from './server.js';

const PUBLIC_URL = 'https://crm.example.test';
const MAX_BYTES = 256 * 1024;

let database: TestDatabase;
let db: Database;
let root: string;
let files: Files;
let storage: Storage;
const servers: Server[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  root = await mkdtemp(join(tmpdir(), 'crm-record-files-'));
  storage = localStorage({ directory: join(root, 'storage') });
  files = createFiles({
    storage,
    uploadDirectory: join(root, 'uploads'),
    maxBytes: MAX_BYTES,
    linkSecret: 'a-files-link-secret-of-32-characters-or-more',
  });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
  await rm(root, { recursive: true, force: true });
});

interface Answer {
  readonly status: number;
  readonly json: unknown;
  readonly body: Buffer;
  readonly headers: Record<string, unknown>;
}
type Api = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  payload?: object | Buffer,
  type?: string,
) => Promise<Answer>;

interface Business {
  readonly api: Api;
  readonly context: TenantContext;
  /** Opens a link's address as a browser would, signed in or not. */
  readonly open: (url: string) => Promise<Answer>;
  readonly contact: () => Promise<string>;
}

/** Someone signed in to a business of their own, calling the API the server composes. */
async function business(): Promise<Business> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const signedIn: Required<DevTenantContext> = {
    agencyId: agency.id,
    businessId: created.id,
    userId: user.id,
  };
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
    mail: undefined,
    files: undefined,
    vault: undefined,
  };
  const server = await buildServer({
    config,
    logger: pino({ level: 'silent' }),
    serveApi: true,
    // The files service's own routes too, as start.ts adds them: a record's file must not
    // be reachable through the general link of any file.
    routes: [
      ...apiRoutes(undefined, undefined, false, PUBLIC_URL, { files }),
      ...fileRoutes(files, { apiUrl: `${PUBLIC_URL}/api/v1` }),
    ],
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
    files,
  });
  servers.push(server);
  const answer = (response: Awaited<ReturnType<typeof server.app.inject>>): Answer => ({
    status: response.statusCode,
    json:
      String(response.headers['content-type']).startsWith('application/') &&
      String(response.headers['content-type']).includes('json')
        ? response.json<unknown>()
        : undefined,
    body: response.rawPayload,
    headers: response.headers,
  });
  const context: TenantContext = {
    ...created.context,
    actorKind: 'user',
    actorId: user.id,
    userId: user.id,
    correlationId: randomUUID(),
  };
  return {
    context,
    api: async (method, path, payload, type) =>
      answer(
        await server.app.inject({
          method,
          url: `/api/v1${path}`,
          ...(payload === undefined ? {} : { payload }),
          ...(type === undefined ? {} : { headers: { 'content-type': type } }),
        }),
      ),
    open: async (url) =>
      answer(await server.app.inject({ method: 'GET', url: url.replace(PUBLIC_URL, '') })),
    contact: async () => toPublicId('contact', (await database.fixtures.contact(context)).id),
  };
}

const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 0x20)]);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 1),
]);
const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 2)]);
const csv = Buffer.from('First,Email\r\nMaya,maya@example.test\r\n');

const field = (overrides: object) => ({
  objectKey: 'contact',
  description: 'A described contact field.',
  options: [],
  currency: null,
  aiFillSources: [],
  aiOverwrite: 'ask',
  archived: false,
  ...overrides,
});
const box = (key: string, label: string) => ({ key, label, description: '', archived: false });

async function fileField(api: Api, key: string, files: object) {
  const created = await api(
    'POST',
    '/fields',
    field({ key, label: key, valueType: 'file', files }),
  );
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  return fieldDefinition.parse(created.json);
}
const upload = (api: Api, contact: string, filename: string, bytes: Buffer, fieldId?: string) =>
  api(
    'POST',
    `/records/${contact}/files?filename=${encodeURIComponent(filename)}${fieldId === undefined ? '' : `&field=${fieldId}`}`,
    bytes,
    // What a browser sends, which nothing trusts.
    'application/octet-stream',
  );
const codeOf = (answer: Answer): unknown =>
  (answer.json as { errors?: { code: string }[] } | undefined)?.errors?.[0]?.code;

describe('a text box list field', () => {
  it('keeps the text of its own boxes, leaves empty ones out and is cleared by none', async () => {
    const { api, contact } = await business();
    const created = await api(
      'POST',
      '/fields',
      field({
        key: 'references',
        label: 'References',
        valueType: 'text_list',
        options: [box('first', 'First'), box('second', 'Second')],
      }),
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const definition = fieldDefinition.parse(created.json);
    expect([definition.valueType, definition.files, definition.display]).toEqual([
      'text_list',
      null,
      null,
    ]);
    const id = await contact();
    const read = async () =>
      recordFields
        .parse((await api('GET', `/records/${id}/fields`)).json)
        .items.find((item) => item.definition.id === definition.id);
    const set = async (value: unknown) => {
      const current = await read();
      return api('PUT', `/records/${id}/fields/${definition.id}`, {
        value,
        revision: current?.revision,
      });
    };
    const saved = await set({ first: 'Ann at 555 0100', second: '  ' });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(recordField.parse(saved.json).value).toEqual({ first: 'Ann at 555 0100' });
    expect((await read())?.value).toEqual({ first: 'Ann at 555 0100' });
    const unknown = await set({ third: 'Not a box' });
    expect([unknown.status, codeOf(unknown)]).toEqual([422, 'invalid_box']);
    const long = await set({ first: 'x'.repeat(1001) });
    expect(long.status).toBe(422);
    expect((await set({ first: '', second: '' })).status).toBe(200);
    expect((await read())?.value).toBeNull();
  });

  it('needs a box, and is never filled by the assistant, a column or a workflow', async () => {
    const { api } = await business();
    const without = await api(
      'POST',
      '/fields',
      field({ key: 'empty_list', label: 'Empty list', valueType: 'text_list' }),
    );
    expect(without.status).toBe(422);
    const assisted = await api(
      'POST',
      '/fields',
      field({
        key: 'assisted_list',
        label: 'Assisted list',
        valueType: 'text_list',
        options: [box('first', 'First')],
        aiFillSources: ['conversations'],
      }),
    );
    expect(assisted.status).toBe(422);
  });
});

describe('a file upload field', () => {
  it('takes only its formats, checked by their bytes, up to its limit, and lists them as its value', async () => {
    const { api, contact } = await business();
    const definition = await fileField(api, 'signed_contract', {
      formats: ['pdf', 'png'],
      limit: 2,
    });
    expect(definition.files).toEqual({ formats: ['pdf', 'png'], limit: 2 });
    const id = await contact();
    // A name that isn't one of the field's formats, and bytes that aren't the name's.
    const csvRefused = await upload(api, id, 'list.csv', csv, definition.id);
    expect([csvRefused.status, codeOf(csvRefused)]).toEqual([422, 'unsupported_type']);
    const disguised = await upload(api, id, 'contract.pdf', docx, definition.id);
    expect([disguised.status, codeOf(disguised)]).toEqual([422, 'type_mismatch']);
    const first = await upload(api, id, 'contract.pdf', pdf, definition.id);
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const kept = recordFile.parse(first.json);
    expect(kept).toMatchObject({
      filename: 'contract.pdf',
      contentType: 'application/pdf',
      size: pdf.length,
      folder: 'internal',
      field: { id: definition.id, label: 'signed_contract' },
      removable: true,
    });
    const second = recordFile.parse(
      (await upload(api, id, 'id-card.PNG', png, definition.id)).json,
    );
    expect(second.contentType).toBe('image/png');
    const full = await upload(api, id, 'more.pdf', pdf, definition.id);
    expect([full.status, codeOf(full)]).toEqual([422, 'field_full']);
    const value = recordFields
      .parse((await api('GET', `/records/${id}/fields`)).json)
      .items.find((item) => item.definition.id === definition.id);
    expect(value?.value).toEqual([kept.id, second.id]);
    expect(value?.source?.kind).toBe('user');
    // Set by uploading and deleting only.
    const direct = await api('PUT', `/records/${id}/fields/${definition.id}`, {
      value: [kept.id],
      revision: value?.revision,
    });
    expect([direct.status, codeOf(direct)]).toEqual([422, 'files_by_upload']);
    // Not cleared either: its files would stay on the record while the field says none.
    const cleared = await api('PUT', `/records/${id}/fields/${definition.id}`, {
      value: null,
      revision: value?.revision,
    });
    expect([cleared.status, codeOf(cleared)]).toEqual([422, 'files_by_upload']);
    // Deleting one takes it out of the value; deleting the last clears it.
    expect((await api('DELETE', `/records/${id}/files/${kept.id}`)).status).toBe(204);
    const after = async () =>
      recordFields
        .parse((await api('GET', `/records/${id}/fields`)).json)
        .items.find((item) => item.definition.id === definition.id)?.value;
    expect(await after()).toEqual([second.id]);
    expect((await api('DELETE', `/records/${id}/files/${second.id}`)).status).toBe(204);
    expect(await after()).toBeNull();
  });

  it('needs its formats and limit, which only a file upload field has', async () => {
    const { api } = await business();
    const without = await api(
      'POST',
      '/fields',
      field({ key: 'scan', label: 'Scan', valueType: 'file' }),
    );
    expect(without.status).toBe(422);
    const tooMany = await api(
      'POST',
      '/fields',
      field({
        key: 'scans',
        label: 'Scans',
        valueType: 'file',
        files: { formats: ['pdf'], limit: 11 },
      }),
    );
    expect(tooMany.status).toBe(422);
    const onText = await api(
      'POST',
      '/fields',
      field({
        key: 'note',
        label: 'Note',
        valueType: 'text',
        files: { formats: ['pdf'], limit: 1 },
      }),
    );
    expect(onText.status).toBe(422);
  });
});

describe("a contact's documents", () => {
  it('lists uploads and the conversation’s attachments by folder, newest first, and finds them by name', async () => {
    const { api, contact, context } = await business();
    const id = await contact();
    const scans = await fileField(api, 'scans', { formats: ['pdf'], limit: 3 });
    const sheet = recordFile.parse((await upload(api, id, 'Guest list.csv', csv)).json);
    const word = recordFile.parse((await upload(api, id, 'Brief.docx', docx)).json);
    const scanned = recordFile.parse((await upload(api, id, 'Scan.pdf', pdf, scans.id)).json);
    expect([sheet.contentType, word.contentType, sheet.field]).toEqual([
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      null,
    ]);
    // An email the contact sent with a file, and one sent to them with another.
    const contactId = parsePublicId('contact', id) ?? '';
    const [received, sent] = await database.withTenant(context, async (sql) => {
      const account = await sql.one<{ id: string }>(
        `insert into messaging.channel_accounts (business_id, channel, name)
         values (app.business_id(), 'email', 'Inbox') returning id`,
      );
      const conversation = await sql.one<{ id: string }>(
        `insert into messaging.conversations (business_id, contact_id) values (app.business_id(), $1) returning id`,
        [contactId],
      );
      const attach = async (direction: 'inbound' | 'outbound', filename: string) => {
        const file = await sql.one<{ id: string }>(
          `insert into files.files (agency_id, business_id, storage, storage_key, filename, content_type, size_bytes, sha256, uploaded_by_kind)
           values (app.agency_id(), app.business_id(), 'local', $1::text, $2, 'application/pdf', 10, sha256(convert_to($1::text, 'UTF8')), 'system')
           returning id`,
          [randomUUID(), filename],
        );
        const message = await sql.one<{ id: string }>(
          `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id, direction, status, author_kind, idempotency_key)
           values (app.business_id(), $1, 'email', $2, $3, $4, $5, $6) returning id`,
          [
            conversation.id,
            account.id,
            direction,
            direction === 'inbound' ? 'received' : 'sent',
            direction === 'inbound' ? 'contact' : 'user',
            direction === 'inbound' ? null : randomUUID(),
          ],
        );
        await sql.query(
          `insert into messaging.message_attachments (business_id, message_id, file_id) values (app.business_id(), $1, $2)`,
          [message.id, file.id],
        );
        return toPublicId('file', file.id);
      };
      return [await attach('inbound', 'Their plan.pdf'), await attach('outbound', 'Our quote.pdf')];
    });
    const list = async (query = '') =>
      recordFilesPage.parse((await api('GET', `/records/${id}/files${query}`)).json);
    const all = await list();
    expect(all.canUpload).toBe(true);
    expect(all.items.map((item) => [item.id, item.folder])).toEqual([
      [sent, 'sent'],
      [received, 'received'],
      [scanned.id, 'internal'],
      [word.id, 'internal'],
      [sheet.id, 'internal'],
    ]);
    expect(all.items.map((item) => item.removable)).toEqual([false, false, true, true, true]);
    expect((await list('?folder=internal')).items.map((item) => item.id)).toEqual([
      scanned.id,
      word.id,
      sheet.id,
    ]);
    expect((await list('?folder=received')).items.map((item) => item.id)).toEqual([received]);
    expect((await list('?folder=sent')).items.map((item) => item.id)).toEqual([sent]);
    expect((await list('?q=guest')).items.map((item) => item.id)).toEqual([sheet.id]);
    // A field's own list: its files, and no attachment.
    expect((await list(`?field=${scans.id}`)).items.map((item) => item.id)).toEqual([scanned.id]);
    // Page by page, every file once.
    const first = await list('?limit=2');
    expect(first.items.map((item) => item.id)).toEqual([sent, received]);
    const next = await list(`?limit=2&after=${first.next ?? ''}`);
    expect(next.items.map((item) => item.id)).toEqual([scanned.id, word.id]);
    const last = await list(`?limit=2&after=${next.next ?? ''}`);
    expect([last.items.map((item) => item.id), last.next]).toEqual([[sheet.id], null]);
    // A message's attachment stays with its message.
    expect((await api('DELETE', `/records/${id}/files/${sent}`)).status).toBe(404);
  });

  it('opens a file by a five-minute link for its own record only, and not once it is deleted', async () => {
    const { api, contact, open } = await business();
    const id = await contact();
    const other = await contact();
    const kept = recordFile.parse((await upload(api, id, 'Contract.pdf', pdf)).json);
    const made = await api('POST', `/records/${id}/files/${kept.id}/links`);
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const link = fileLink.parse(made.json);
    const lasts = (Date.parse(link.expiresAt) - Date.now()) / 1000;
    expect(lasts).toBeGreaterThan(240);
    expect(lasts).toBeLessThanOrEqual(300);
    const opened = await open(link.url);
    expect(opened.status).toBe(200);
    expect(opened.body.equals(pdf)).toBe(true);
    expect(String(opened.headers['content-disposition'])).toMatch(/^attachment/);
    expect(opened.headers['x-content-type-options']).toBe('nosniff');
    expect((await api('POST', `/records/${other}/files/${kept.id}/links`)).status).toBe(404);
    // The general link of a file never opens one of a record's: only the record's link does,
    // for whoever may see the record.
    expect((await api('POST', `/files/${kept.id}/links`, { expiresIn: 60 })).status).toBe(404);
    expect((await api('DELETE', `/records/${other}/files/${kept.id}`)).status).toBe(404);
    expect((await api('DELETE', `/records/${id}/files/${kept.id}`)).status).toBe(204);
    expect((await open(link.url)).status).toBe(404);
    expect((await api('POST', `/records/${id}/files/${kept.id}/links`)).status).toBe(404);
  });

  it("is another business's to see: its records, files and links are not found", async () => {
    const mine = await business();
    const theirs = await business();
    const id = await mine.contact();
    const kept = recordFile.parse((await upload(mine.api, id, 'Contract.pdf', pdf)).json);
    for (const [method, path] of [
      ['GET', `/records/${id}/files`],
      ['POST', `/records/${id}/files/${kept.id}/links`],
      ['DELETE', `/records/${id}/files/${kept.id}`],
    ] as const)
      expect((await theirs.api(method, path)).status, `${method} ${path}`).toBe(404);
    expect((await upload(theirs.api, id, 'Mine.pdf', pdf)).status).toBe(404);
    expect(
      recordFilesPage.parse((await mine.api('GET', `/records/${id}/files`)).json).items,
    ).toHaveLength(1);
  });

  it('refuses a file over the limit before it is kept, and any format not a document', async () => {
    const { api, contact } = await business();
    const id = await contact();
    const large = await upload(api, id, 'Huge.pdf', Buffer.concat([pdf, Buffer.alloc(MAX_BYTES)]));
    expect(large.status).toBe(413);
    for (const name of ['page.html', 'tool.exe', 'notes.txt', 'drawing.svg']) {
      const refused = await upload(api, id, name, csv);
      expect([refused.status, codeOf(refused)], name).toEqual([422, 'unsupported_type']);
    }
    // A CSV holding bytes no text has.
    const binary = await upload(api, id, 'list.csv', Buffer.concat([png, Buffer.alloc(4, 0)]));
    expect([binary.status, codeOf(binary)]).toEqual([422, 'type_mismatch']);
    expect(recordFilesPage.parse((await api('GET', `/records/${id}/files`)).json).items).toEqual(
      [],
    );
  });
});

describe('the contact list and an import, with the new field types', () => {
  it('filters by whether a text box list or a file field is set, and sorts on neither', async () => {
    const { api, contact } = await business();
    const definition = await fileField(api, 'brief', { formats: ['pdf'], limit: 1 });
    const withFile = await contact();
    await contact();
    expect((await upload(api, withFile, 'Brief.pdf', pdf, definition.id)).status).toBe(201);
    const ids = async (query: string) => {
      const answer = await api('GET', `/contacts?${query}`);
      expect(answer.status, JSON.stringify(answer.json)).toBe(200);
      return (answer.json as { items: { id: string }[] }).items.map((item) => item.id);
    };
    expect(await ids(`fieldId=${definition.id}&fieldOperator=is_set`)).toEqual([withFile]);
    expect(await ids(`fieldId=${definition.id}&fieldOperator=is_unset`)).not.toContain(withFile);
    const compared = await api(
      'GET',
      `/contacts?fieldId=${definition.id}&fieldOperator=contains&fieldValue=brief`,
    );
    expect([compared.status, codeOf(compared)]).toEqual([422, 'invalid_operator']);
    const sorted = await api('GET', `/contacts?sortField=${definition.id}`);
    expect([sorted.status, codeOf(sorted)]).toEqual([422, 'unsortable_field']);
    // The list's column shows the field's files by id.
    const column = await api('GET', `/contacts?fields=${definition.id}`);
    const row = (
      column.json as { items: { id: string; fields?: Record<string, unknown> }[] }
    ).items.find((item) => item.id === withFile);
    expect(Array.isArray(row?.fields?.[definition.id])).toBe(true);
  });
});

describe('a purged contact', () => {
  it('takes its files with it: deleted, unlinkable, and their bytes queued for removal', async () => {
    const { api, contact } = await business();
    const id = await contact();
    const definition = await fileField(api, 'id_scan', { formats: ['pdf'], limit: 1 });
    const document = recordFile.parse((await upload(api, id, 'Brief.pdf', pdf)).json);
    const scanned = recordFile.parse((await upload(api, id, 'Scan.pdf', pdf, definition.id)).json);
    expect((await api('DELETE', `/contacts/${id}`)).status).toBe(200);
    expect((await api('DELETE', `/trash/${id}`)).status).toBe(204);
    const ids = [document.id, scanned.id].map((each) => parsePublicId('file', each) ?? '');
    const state = await database.as('crm_owner', (sql) =>
      sql.query<{ deleted: boolean; queued: boolean }>(
        `select f.deleted_at is not null as deleted,
                exists (select 1 from graphile_worker.jobs j
                        where j.task_identifier = 'files.remove_bytes'
                          and j.key = 'files.remove_bytes:' || f.id::text) as queued
         from files.files f where f.id = any($1::uuid[]) order by f.id`,
        [ids],
      ),
    );
    expect(state).toEqual([
      { deleted: true, queued: true },
      { deleted: true, queued: true },
    ]);
    // Once the worker runs, the bytes are gone too.
    const task = files.tasks.find((each) => each.name === 'files.remove_bytes');
    const scope = await database.as('crm_owner', (sql) =>
      sql.one<{ agency_id: string; business_id: string }>(
        'select agency_id, business_id from files.files where id = $1',
        [ids[0]],
      ),
    );
    for (const fileId of ids)
      await task?.run(
        { fileId },
        {
          invocation: {
            context: {
              agencyId: scope.agency_id,
              businessId: scope.business_id,
              actorKind: 'system',
              correlationId: randomUUID(),
            },
            permissions: 'all',
          },
          services: { db, authorize: allowEveryone },
        },
      );
    for (const fileId of ids) expect(await storage.get(fileId)).toBeUndefined();
  });
});
