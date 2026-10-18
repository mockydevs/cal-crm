import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { allowEveryone, type Invocation } from '@repo/commands';
import {
  fieldDefinition,
  fileLink,
  recordFile,
  recordFields,
  recordFilesPage,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import {
  ConflictError,
  ContentTooLargeError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { detailOptions, team } from '../../test/contact-details.js';
import {
  crmRoutes,
  recordFileRoutes,
  type MessageAttachments,
  type RecordFileStore,
} from '../index.js';

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function scene(messageAttachments?: MessageAttachments, withStorage = true) {
  const t = await team(database);
  const invocation = (await t.member('Dana')).as();
  const contact = await database.fixtures.contact(t.context);
  const id = toPublicId('contact', contact.id);
  // File validation and storage have their own integration suite; this boundary keeps
  // real file rows in the caller's transaction while these tests exercise the CRM API.
  const staged = new Map<string, string>();
  const store: RecordFileStore = {
    maxBytes: 1024,
    receive(body) {
      body.resume();
      return Promise.resolve({ upload: randomUUID(), discard: () => Promise.resolve() });
    },
    async stageDocument(_services, _upload, document) {
      const { id: key } = await db
        .selectNoFrom(sql<string>`uuidv7()`.as('id'))
        .executeTakeFirstOrThrow();
      staged.set(key, document.filename);
      return {
        id: key,
        discard: () => {
          staged.delete(key);
          return Promise.resolve();
        },
      };
    },
    async keepStaged(trx, command, stagedId, keep) {
      const filename = staged.get(stagedId);
      if (filename === undefined) throw new Error('No staged document.');
      const row = await trx
        .insertInto('files.files')
        .values({
          id: stagedId,
          agency_id: command.context.agencyId,
          business_id: command.context.businessId ?? null,
          storage: 'local',
          storage_key: stagedId,
          filename,
          content_type: 'application/pdf',
          size_bytes: 100,
          sha256: Buffer.alloc(32),
          uploaded_by_kind: command.context.actorKind,
          uploaded_by_id: command.context.actorId ?? null,
          purpose: keep.purpose,
        })
        .returning('created_at')
        .executeTakeFirstOrThrow();
      return {
        id: toPublicId('file', stagedId),
        filename,
        contentType: 'application/pdf',
        size: 100,
        sha256: '0'.repeat(64),
        createdAt: row.created_at.toISOString(),
      };
    },
    link: (_services, _invocation, fileId, lifetime) =>
      Promise.resolve({
        path: `/files/${fileId}/content?for=${lifetime.purpose ?? 'message_attachment'}`,
        expiresAt: '2030-01-01T00:00:00.000Z',
      }),
  };
  const routes = [
    ...recordFileRoutes({
      store: withStorage ? store : undefined,
      messageAttachments,
      actorNames: detailOptions().actorNames,
      apiUrl: 'https://crm.example.test/api/v1',
    }),
    ...crmRoutes,
  ];
  const call = async (
    operationId: string,
    request: { params?: Record<string, string>; query?: object; body?: unknown } = {},
    actor: Invocation = invocation,
  ) => {
    const route = routes.find((each) => each.endpoint.operationId === operationId);
    if (route === undefined) throw new Error(`Missing ${operationId} route.`);
    return route.run(
      {
        invocation: actor,
        params: route.endpoint.path.includes('{id}')
          ? { id, ...request.params }
          : (request.params ?? {}),
        query: request.query ?? {},
        body: request.body,
      },
      { db, authorize: allowEveryone },
    );
  };
  const upload = async (filename: string, field?: string, actor = invocation) =>
    recordFile.parse(
      await call(
        'uploadRecordFile',
        {
          query: { filename, ...(field === undefined ? {} : { field }) },
          body: { stream: Readable.from(['test-only']), contentLength: 9 },
        },
        actor,
      ),
    );
  const list = async (query = {}, actor = invocation) =>
    recordFilesPage.parse(await call('listRecordFiles', { query }, actor));
  const field = async (limit = 1, valueType: 'file' | 'text' = 'file') =>
    fieldDefinition.parse(
      await call('createField', {
        body: {
          objectKey: 'contact',
          key: `documents_${String(limit)}_${valueType}`,
          label: `Documents ${String(limit)} ${valueType}`,
          description: 'Documents supplied by the contact.',
          valueType,
          currency: null,
          options: [],
          aiFillSources: [],
          aiOverwrite: 'never',
          archived: false,
          ...(valueType === 'file' ? { files: { formats: ['pdf'], limit } } : {}),
        },
      }),
    );
  return { t, id, invocation, call, upload, list, field, store, staged };
}

it('uploads, pages, searches, links and removes only a record’s own documents', async () => {
  const s = await scene();
  const first = await s.upload('first.pdf');
  const second = await s.upload('second.pdf');
  expect(first).toMatchObject({
    folder: 'internal',
    field: null,
    removable: true,
    addedBy: { you: true },
  });
  const page = await s.list({ limit: 1 });
  expect(page.items.map((item) => item.id)).toEqual([second.id]);
  expect(page.items[0]?.addedBy?.name).toBe('Dana');
  expect(page.next).not.toBeNull();
  const next = await s.list({ limit: 1, after: page.next });
  expect(next.items.map((item) => item.id)).toEqual([first.id]);
  expect(next.next).toBeNull();
  expect((await s.list({ q: 'second', folder: 'internal' })).items.map((item) => item.id)).toEqual([
    second.id,
  ]);
  expect((await s.list({ folder: 'sent' })).items).toEqual([]);
  const link = fileLink.parse(
    await s.call('createRecordFileLink', { params: { fileId: first.id } }),
  );
  expect(link.url).toBe(
    `https://crm.example.test/api/v1/files/${first.id}/content?for=record_file`,
  );
  await s.call('deleteRecordFile', { params: { fileId: first.id } });
  expect((await s.list()).items.map((item) => item.id)).toEqual([second.id]);
  await expect(s.call('createRecordFileLink', { params: { fileId: first.id } })).rejects.toThrow(
    NotFoundError,
  );
  await expect(s.call('deleteRecordFile', { params: { fileId: first.id } })).rejects.toThrow(
    NotFoundError,
  );
});

it('keeps a file upload field’s value in sync through additions and removal of its last file', async () => {
  const s = await scene();
  const field = await s.field(2);
  const first = await s.upload('first.pdf', field.id);
  const second = await s.upload('second.pdf', field.id);
  const value = async () =>
    recordFields
      .parse(await s.call('getRecordFields'))
      .items.find((item) => item.definition.id === field.id)?.value;
  expect(await value()).toEqual([first.id, second.id]);
  expect(first.field).toEqual({ id: field.id, label: field.label });
  expect((await s.list({ field: field.id })).items).toHaveLength(2);
  await expect(s.upload('third.pdf', field.id)).rejects.toMatchObject({
    issues: [{ code: 'field_full' }],
  });
  await s.call('deleteRecordFile', { params: { fileId: first.id } });
  expect(await value()).toEqual([second.id]);
  await s.call('deleteRecordFile', { params: { fileId: second.id } });
  expect(await value()).toBeNull();
});

it('refuses a full single-file field, a non-file field and a disallowed format', async () => {
  const s = await scene();
  const file = await s.field();
  const text = await s.field(1, 'text');
  await expect(s.upload('picture.png', file.id)).rejects.toMatchObject({
    issues: [{ code: 'unsupported_type' }],
  });
  await expect(s.upload('brief.pdf', text.id)).rejects.toMatchObject({
    issues: [{ code: 'not_a_file_field' }],
  });
  await s.upload('first.pdf', file.id);
  await expect(s.upload('second.pdf', file.id)).rejects.toMatchObject({
    issues: [{ code: 'field_full' }],
  });
});

it('requires field-value permission for adding or deleting field files', async () => {
  const s = await scene();
  const field = await s.field();
  const uploader = { ...s.invocation, permissions: new Set<Permission>(['files.upload']) };
  await expect(s.upload('brief.pdf', field.id, uploader)).rejects.toThrow(ForbiddenError);
  const file = await s.upload('brief.pdf', field.id);
  expect((await s.list({}, uploader)).items[0]?.removable).toBe(false);
  await expect(
    s.call('deleteRecordFile', { params: { fileId: file.id } }, uploader),
  ).rejects.toThrow(ForbiddenError);
  expect((await s.list()).items).toHaveLength(1);
});

it('hides foreign records before validating their upload query, and refuses unrelated file links', async () => {
  const s = await scene();
  const other = await scene();
  const file = await other.upload('private.pdf');
  await expect(s.call('uploadRecordFile', { params: { id: other.id }, query: {} })).rejects.toThrow(
    NotFoundError,
  );
  await expect(s.call('listRecordFiles', { params: { id: other.id } })).rejects.toThrow(
    NotFoundError,
  );
  await expect(s.call('createRecordFileLink', { params: { fileId: file.id } })).rejects.toThrow(
    NotFoundError,
  );
  await expect(s.call('deleteRecordFile', { params: { fileId: file.id } })).rejects.toThrow(
    NotFoundError,
  );
});

it('refuses oversized bodies and changes to documents on a trashed record', async () => {
  const s = await scene();
  await expect(
    s.call('uploadRecordFile', {
      query: { filename: 'large.pdf' },
      body: { stream: Readable.from(['test-only']), contentLength: 1025 },
    }),
  ).rejects.toThrow(ContentTooLargeError);
  const file = await s.upload('brief.pdf');
  await s.call('trashContact');
  expect((await s.list()).canUpload).toBe(false);
  expect((await s.list()).items[0]?.removable).toBe(false);
  await expect(s.upload('later.pdf')).rejects.toThrow(ConflictError);
  await expect(s.call('deleteRecordFile', { params: { fileId: file.id } })).rejects.toThrow(
    ConflictError,
  );
});

it('lists and links conversation attachments without offering to delete them as uploads', async () => {
  const ids = await db
    .selectNoFrom([sql<string>`uuidv7()`.as('inbound'), sql<string>`uuidv7()`.as('outbound')])
    .executeTakeFirstOrThrow();
  const attachments = [
    { fileId: ids.inbound, filename: 'received.pdf', direction: 'inbound' as const },
    { fileId: ids.outbound, filename: 'sent.pdf', direction: 'outbound' as const },
  ].map((file) => ({
    ...file,
    contentType: 'application/pdf',
    size: 100,
    attachedAt: '2030-01-01T00:00:00.000000Z',
    authorKind: 'system' as const,
    authorId: null,
  }));
  const s = await scene({
    list: (_trx, query) =>
      Promise.resolve(
        attachments.filter(
          (file) => query.direction === undefined || file.direction === query.direction,
        ),
      ),
    has: (_trx, _contactId, fileId) =>
      Promise.resolve(attachments.some((file) => file.fileId === fileId)),
  });
  for (const [folder, filename, id] of [
    ['sent', 'sent.pdf', ids.outbound],
    ['received', 'received.pdf', ids.inbound],
  ] as const) {
    const page = await s.list({ folder });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      filename,
      folder,
      removable: false,
      addedBy: { kind: 'system', name: null, you: false },
    });
    const fileId = toPublicId('file', id);
    const link = fileLink.parse(await s.call('createRecordFileLink', { params: { fileId } }));
    expect(link.url).toContain('for=message_attachment');
    await expect(s.call('deleteRecordFile', { params: { fileId } })).rejects.toThrow(NotFoundError);
  }
  await s.upload('own.pdf');
  expect((await s.list()).items.map((file) => file.filename).sort()).toEqual([
    'own.pdf',
    'received.pdf',
    'sent.pdf',
  ]);
  const field = await s.field();
  expect((await s.list({ field: field.id })).items).toEqual([]);
});

it('keeps archived field documents visible and refuses changing them until the field is restored', async () => {
  const s = await scene();
  const field = await s.field();
  const file = await s.upload('brief.pdf', field.id);
  await s.call('updateField', {
    params: { fieldId: field.id },
    body: {
      label: field.label,
      description: field.description,
      options: field.options,
      aiFillSources: field.aiFillSources,
      aiOverwrite: field.aiOverwrite,
      archived: true,
      revision: field.revision,
    },
  });
  expect((await s.list()).items[0]).toMatchObject({ id: file.id, removable: false });
  await expect(s.upload('later.pdf', field.id)).rejects.toThrow(ConflictError);
  await expect(s.call('deleteRecordFile', { params: { fileId: file.id } })).rejects.toThrow(
    ConflictError,
  );
});

it('reports unavailable storage and rejects a malformed upload body without adding a document', async () => {
  const unavailable = await scene(undefined, false);
  await expect(unavailable.upload('brief.pdf')).rejects.toMatchObject({
    issues: [{ code: 'files_unavailable' }],
  });
  expect((await unavailable.list()).items).toEqual([]);
  const s = await scene();
  await expect(
    s.call('uploadRecordFile', { query: { filename: 'brief.pdf' }, body: {} }),
  ).rejects.toThrow('uploadRecordFile takes the request body unread');
  expect((await s.list()).items).toEqual([]);
});

it('serializes competing uploads so a single-file field keeps exactly one document', async () => {
  const s = await scene();
  const field = await s.field();
  // Each upload waits, after counting the field's files, for the other to get that far. While
  // the record is held the other can't, so the wait runs out and they go one after the other;
  // without the hold both would count none, meet here and both be kept.
  const keepStaged = s.store.keepStaged.bind(s.store);
  let arrived = 0;
  let meet = (): void => undefined;
  const met = new Promise<void>((resolve) => {
    meet = resolve;
  });
  s.store.keepStaged = async (...args) => {
    arrived += 1;
    if (arrived === 2) meet();
    await Promise.race([met, delay(1000)]);
    return keepStaged(...args);
  };
  const results = await Promise.allSettled([
    s.upload('one.pdf', field.id),
    s.upload('two.pdf', field.id),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const refused = results.find((result) => result.status === 'rejected');
  if (refused?.status !== 'rejected') throw new Error('Both uploads were accepted.');
  expect(refused.reason as unknown).toMatchObject({ issues: [{ code: 'field_full' }] });
  expect((await s.list({ field: field.id })).items).toHaveLength(1);
});

it('cleans up a staged document when keeping its file fails', async () => {
  const s = await scene();
  s.store.keepStaged = () => Promise.reject(new Error('The file store is unavailable.'));
  await expect(s.upload('brief.pdf')).rejects.toThrow('The file store is unavailable.');
  expect(s.staged.size).toBe(0);
  expect((await s.list()).items).toEqual([]);
});

it('lists a system-authored document for a reader but refuses an upload without permission', async () => {
  const s = await scene();
  await s.upload('generated.pdf', undefined, s.t.system());
  const viewer = { ...s.invocation, permissions: new Set<Permission>() };
  const page = await s.list({}, viewer);
  expect(page.canUpload).toBe(false);
  expect(page.items[0]).toMatchObject({
    removable: false,
    addedBy: { kind: 'system', name: null, you: false },
  });
  await expect(s.upload('brief.pdf', undefined, viewer)).rejects.toThrow(ForbiddenError);
  await expect(s.upload('program.exe')).rejects.toMatchObject({
    issues: [{ code: 'unsupported_type' }],
  });
  expect((await s.list()).items).toHaveLength(1);
});
