// The files service: uploads checked and stored, and signed links to read them. It owns
// files.files; the bytes live in a storage backend (@repo/storage) under each file's id.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open as openFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';

import {
  defineCommand,
  defineTask,
  requireBusiness,
  requirePermission,
  runCommand,
  type Command,
  type AnyTask,
  type CommandContext,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  parseInput,
  publicId,
  type DocumentFormat,
  type FileType,
  type StoredFile,
} from '@repo/contracts';
import { withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import {
  ContentTooLargeError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import type { Storage } from '@repo/storage';
import { sql } from 'kysely';
import * as z from 'zod';

import { checkDocument, DOCUMENT_HEAD_BYTES } from './documents.js';
import { checkFileLink, signFileLink, type FileScope } from './links.js';
import { canManageMedia, lockedFolder } from './media-folders.js';
import { checkBusinessQuota } from './media.js';
import { receiveUpload } from './receive.js';
import { checkType, HEAD_BYTES, showsInline } from './types.js';

export interface FilesOptions {
  readonly storage: Storage;
  /** Where uploads wait while they're checked; only the server writes there. */
  readonly uploadDirectory: string;
  /** The largest upload taken, in bytes. */
  readonly maxBytes: number;
  /** Signs download links (FILES_LINK_SECRET). */
  readonly linkSecret: string;
  /**
   * The most a business's live files may add up to (FILES_BUSINESS_QUOTA_BYTES), when the
   * install sets a limit: an upload that would pass it is refused.
   */
  readonly businessQuotaBytes?: number | undefined;
}

/** What file.create takes: a received upload, by its name in the upload directory. */
export const createFileInput = z.strictObject({
  upload: z.uuid(),
  filename: z
    .string()
    .trim()
    .min(1, { error: 'Give the file a name.' })
    .max(255, { error: 'Use at most 255 characters.' })
    // Control characters break headers; direction overrides can disguise an extension.
    .regex(/^[^\p{Cc}‪-‮⁦-⁩]*$/u, {
      error: "A file name can't hold control characters.",
    }),
  /** The type it was sent with: a Content-Type, parameters allowed. */
  contentType: z.string().max(255).optional(),
  /** Puts the file in the business's media library, at its top or in a folder. */
  library: z.strictObject({ folderId: publicId('media_folder').nullable() }).optional(),
});

export interface Upload {
  readonly body: Readable;
  /** The request's Content-Type. */
  readonly contentType: string | undefined;
  readonly filename: string;
  /** Into the business's media library: at its top (null), or in a folder. */
  readonly library?: { readonly folderId: string | null } | undefined;
}

/** A file opened by its link: the bytes, and what the response needs to say about them. */
export interface OpenedFile {
  readonly body: Readable;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  /** Shown in the browser (raster images) rather than downloaded. */
  readonly inline: boolean;
}

export type OpenResult = OpenedFile | { readonly refused: 'invalid' | 'expired' | 'not_found' };

/** A stored file and the way to its bytes, for work on what it holds, such as an import. */
export interface FileContent {
  readonly file: StoredFile;
  /** The agency's own file, which every business of the agency can see, not one business's. */
  readonly shared: boolean;
  /** Opens the bytes, from their start. Read the stream to its end, or destroy it. */
  open(): Promise<Readable>;
}

/** An upload waiting in the upload directory, received but not yet kept. */
export interface ReceivedUpload {
  /** Its name in the upload directory, for stageDocument. */
  readonly upload: string;
  /** Removes it from the upload directory, whether it was kept or not. */
  discard(): Promise<void>;
}

/**
 * A document checked and stored, with no row yet: what a command keeps with keepStaged.
 * Until then it is this process's alone.
 */
export interface StagedDocument {
  /** The id its row will have, which its bytes are stored under: a UUID. */
  readonly id: string;
  readonly format: DocumentFormat;
  /** Removes the stored bytes: for a document no command kept. */
  discard(): Promise<void>;
}

export interface Files {
  readonly createFileCommand: Command<typeof createFileInput, StoredFile>;
  /** The largest upload taken, in bytes. */
  readonly maxBytes: number;
  /** Receives an upload, at most maxBytes, and runs file.create on it. */
  upload(services: Services, invocation: Invocation, upload: Upload): Promise<StoredFile>;
  /**
   * A signed link to a file the invocation can see, as a path under the API's base
   * (/files/{id}/content?…), lasting the given seconds (at most seven days).
   */
  link(
    services: Services,
    invocation: Invocation,
    fileId: string,
    lifetime: {
      readonly seconds: number;
      readonly now?: Date;
      /**
       * What the file is kept for, which a file kept for one purpose must be linked by: a
       * file with a purpose is not found without it, and a file without one not with it.
       */
      readonly purpose?: FilePurpose;
    },
  ): Promise<{ path: string; expiresAt: string }>;
  /**
   * A file the invocation can see, with the way to its bytes; undefined when there is none.
   * Read under row-level security, as a link is made, so it stays in the invocation's
   * agency and business. Whether the caller may do the work it wants the bytes for is the
   * caller's to check.
   */
  content(
    services: Services,
    invocation: Invocation,
    fileId: string,
  ): Promise<FileContent | undefined>;
  /**
   * The same, read in the caller's own transaction: for a command or a read that already
   * holds one, such as an invoice printed with the business's logo.
   */
  contentIn(trx: DatabaseTransaction, fileId: string): Promise<FileContent | undefined>;
  /**
   * Keeps bytes the server itself made, such as the PDF of an invoice being emailed, as a
   * file of the command's business, in the command's transaction: the row is written with
   * the command's change or not at all. The type is checked against the bytes as an
   * upload's is. Whether the actor may do what the file is for is the caller's command's
   * to check; no upload permission is asked, because nobody uploaded anything.
   */
  store(
    trx: DatabaseTransaction,
    command: CommandContext,
    file: {
      readonly filename: string;
      readonly contentType: FileType;
      readonly content: Uint8Array;
      /** Kept for one purpose only: linked only by it, and never read as content. */
      readonly purpose?: FilePurpose;
      /** It counts against the business's storage quota, as an upload does. */
      readonly quota?: boolean;
    },
  ): Promise<StoredFile>;
  /**
   * Receives a request's bytes, at most maxBytes, into the upload directory, for
   * stageDocument.
   */
  receive(body: Readable): Promise<ReceivedUpload>;
  /**
   * Checks a received upload as a document and stores its bytes, outside any transaction
   * so that no row is held while they are hashed and written: its format is read from its
   * name, must be one of the formats given, and its first bytes must agree. A command then
   * keeps it with keepStaged, or the caller throws it away with its discard.
   */
  stageDocument(
    services: Services,
    upload: string,
    document: { readonly filename: string; readonly formats: readonly DocumentFormat[] },
  ): Promise<StagedDocument>;
  /**
   * Keeps a staged document as a file of the command's business, in the command's
   * transaction, once: its format must still be one of those given, and the business's
   * storage quota holds. It is stored under its format's own type, for the purpose given.
   * Whether the actor may add it where it goes is the caller's command's to check.
   */
  keepStaged(
    trx: DatabaseTransaction,
    command: CommandContext,
    stagedId: string,
    keep: { readonly formats: readonly DocumentFormat[]; readonly purpose: FilePurpose },
  ): Promise<StoredFile>;
  /**
   * Deletes one of the command's business's files for good, in the command's transaction:
   * the row is marked deleted, and the worker removes the bytes once that commits
   * (files.remove_bytes, queued by the database). Whether the actor may delete it is the
   * caller's command's to check.
   */
  discard(trx: DatabaseTransaction, command: CommandContext, fileId: string): Promise<void>;
  /** The worker's tasks: removing a deleted file's bytes from storage. */
  readonly tasks: readonly AnyTask[];
  /** Opens a file by its link: no one need be signed in, since the link is the permission. */
  open(
    db: Database,
    request: {
      readonly fileId: string;
      readonly query: unknown;
      readonly now: Date;
      readonly correlationId: string;
    },
  ): Promise<OpenResult>;
}

const columns = [
  'id',
  'agency_id',
  'business_id',
  'storage_key',
  'filename',
  'content_type',
  'size_bytes',
  'sha256',
  'created_at',
  'purpose',
] as const;

interface FileRow {
  id: string;
  agency_id: string;
  business_id: string | null;
  storage_key: string;
  filename: string;
  content_type: string;
  size_bytes: string;
  sha256: Buffer;
  created_at: Date;
  purpose: string | null;
}

/**
 * What a file can be kept for, when only one way may reach it (migration 0118's
 * files.files.purpose). contact_export: a bulk export's CSV of contacts. record_file: a
 * document of a record or a file of its file upload field, linked only through its record.
 */
export type FilePurpose = 'contact_export' | 'record_file';

/** A file as the API shows it. */
function asStoredFile(row: FileRow): StoredFile {
  return {
    id: toPublicId('file', row.id),
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size_bytes),
    sha256: row.sha256.toString('hex'),
    createdAt: row.created_at.toISOString(),
  };
}

/** The file, if the transaction's tenant context can see it and it isn't deleted. */
function readFile(trx: DatabaseTransaction, id: string): Promise<FileRow | undefined> {
  return trx
    .selectFrom('files.files')
    .select(columns)
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
}

/** An upload's size, SHA-256 and first bytes, read from its file; undefined if it's gone. */
async function inspect(
  path: string,
  headBytes = HEAD_BYTES,
): Promise<{ size: number; sha256: Buffer; head: Buffer } | undefined> {
  const file = await openFile(path, 'r').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (file === undefined) return undefined;
  const hash = createHash('sha256');
  const head: Buffer[] = [];
  let size = 0;
  for await (const chunk of file.createReadStream()) {
    const bytes = chunk as Buffer;
    if (size < headBytes) head.push(bytes.subarray(0, headBytes - size));
    size += bytes.length;
    hash.update(bytes);
  }
  return { size, sha256: hash.digest(), head: Buffer.concat(head) };
}

export function createFiles(options: FilesOptions): Files {
  const { storage, uploadDirectory, maxBytes, linkSecret, businessQuotaBytes } = options;

  const createFileCommand = defineCommand({
    name: 'file.create',
    permission: 'files.upload',
    input: createFileInput,
    async handle(trx, input, command): Promise<StoredFile> {
      const { context } = command;
      const path = join(uploadDirectory, input.upload);
      const upload = await inspect(path);
      if (upload === undefined) {
        throw new ValidationError([
          { path: '/upload', code: 'not_found', message: 'There is no upload with this id.' },
        ]);
      }
      if (upload.size > maxBytes) throw new ContentTooLargeError(maxBytes);
      const { contentType } = checkType(input.contentType, upload.head);
      if (context.businessId !== undefined)
        await checkBusinessQuota(trx, context.businessId, upload.size, businessQuotaBytes);
      // A library is one business's, and changing it is its own permission.
      let folderId: string | null = null;
      if (input.library !== undefined) {
        if (!canManageMedia(command))
          throw new ForbiddenError(
            "Your role can't add files to the media library.",
            'media.manage',
          );
        folderId = await lockedFolder(trx, requireBusiness(context), input.library.folderId);
      }
      // The id comes first: it's the storage key too.
      const { id } = await trx
        .selectNoFrom(sql<string>`uuidv7()`.as('id'))
        .executeTakeFirstOrThrow();
      const row = await trx
        .insertInto('files.files')
        .values({
          id,
          agency_id: context.agencyId,
          business_id: context.businessId ?? null,
          storage: storage.kind,
          storage_key: id,
          filename: input.filename,
          content_type: contentType,
          size_bytes: upload.size,
          sha256: upload.sha256,
          uploaded_by_kind: context.actorKind,
          uploaded_by_id: context.actorId ?? null,
          library: input.library !== undefined,
          folder_id: folderId,
        })
        .returning(columns)
        .executeTakeFirstOrThrow();
      // Stored last, so a failure here rolls the row back with it.
      await storage.put(id, createReadStream(path), { size: upload.size, contentType });
      await command.emit({
        type: 'file.uploaded',
        subject: { kind: 'file', id },
        payload: {
          filename: row.filename,
          contentType,
          size: upload.size,
          ...(input.library === undefined ? {} : { library: true }),
        },
      });
      return asStoredFile(row);
    },
  });

  // Documents checked and stored, waiting for the command that keeps them.
  const staged = new Map<
    string,
    {
      readonly filename: string;
      readonly format: DocumentFormat;
      readonly contentType: string;
      readonly size: number;
      readonly sha256: Buffer;
    }
  >();

  // A deleted file's bytes, removed once its deletion has committed. The database queues
  // the job (migration 0120); a file not deleted, or already gone, leaves nothing to do.
  const removeBytes = defineTask({
    name: 'files.remove_bytes',
    data: z.object({ fileId: z.uuid() }),
    async run({ fileId }, { invocation, services }) {
      const row = await withTenant(services.db, invocation.context, (trx) =>
        trx
          .selectFrom('files.files')
          .select('storage_key')
          .where('id', '=', fileId)
          .where('deleted_at', 'is not', null)
          .executeTakeFirst(),
      );
      if (row !== undefined) await storage.delete(row.storage_key);
    },
  });

  const contentIn: Files['contentIn'] = async (trx, fileId) => {
    const id = parsePublicId('file', fileId);
    const row = id === undefined ? undefined : await readFile(trx, id);
    // A file kept for one purpose is reached only through it, never as content.
    if (row?.purpose !== null) return undefined;
    return {
      file: asStoredFile(row),
      shared: row.business_id === null,
      async open() {
        const body = await storage.get(row.storage_key);
        if (body === undefined) throw new Error(`The bytes of file ${fileId} are missing.`);
        return body;
      },
    };
  };

  return {
    createFileCommand,
    maxBytes,

    async upload(services, invocation, upload) {
      // Before a byte is received: someone whose role can't upload sends nothing in vain.
      await requirePermission(services, createFileCommand, invocation);
      const received = await receiveUpload(upload.body, { directory: uploadDirectory, maxBytes });
      try {
        return await runCommand(
          services,
          createFileCommand,
          {
            upload: basename(received.path),
            filename: upload.filename,
            contentType: upload.contentType,
            ...(upload.library === undefined ? {} : { library: upload.library }),
          },
          invocation,
        );
      } finally {
        await rm(received.path, { force: true });
      }
    },

    async link(services, invocation, fileId, { seconds, now = new Date(), purpose }) {
      const id = parsePublicId('file', fileId);
      const row =
        id === undefined
          ? undefined
          : await withTenant(services.db, invocation.context, (trx) => readFile(trx, id));
      if (row?.purpose !== (purpose ?? null)) throw new NotFoundError('file', fileId);
      const scope: FileScope = {
        agencyId: row.agency_id,
        businessId: row.business_id ?? undefined,
      };
      const query = signFileLink(linkSecret, row.id, scope, { now, seconds });
      const expires = Number(new URLSearchParams(query).get('expires'));
      return {
        path: `/files/${toPublicId('file', row.id)}/content?${query}`,
        expiresAt: new Date(expires * 1000).toISOString(),
      };
    },

    content(services, invocation, fileId) {
      return withTenant(services.db, invocation.context, (trx) => contentIn(trx, fileId));
    },

    contentIn,

    async receive(body) {
      const received = await receiveUpload(body, { directory: uploadDirectory, maxBytes });
      return {
        upload: basename(received.path),
        discard: () => rm(received.path, { force: true }),
      };
    },

    async stageDocument(services, upload, document) {
      const { filename } = parseInput(createFileInput.pick({ filename: true }), {
        filename: document.filename,
      });
      const { upload: name } = parseInput(createFileInput.pick({ upload: true }), { upload });
      const path = join(uploadDirectory, name);
      const inspected = await inspect(path, DOCUMENT_HEAD_BYTES);
      if (inspected === undefined)
        throw new ValidationError([
          { path: '/upload', code: 'not_found', message: 'There is no upload with this id.' },
        ]);
      if (inspected.size > maxBytes) throw new ContentTooLargeError(maxBytes);
      const { format, contentType } = checkDocument(filename, inspected.head, document.formats);
      // The id comes first: it's the storage key too, and the row's when it is kept.
      const { id } = await services.db
        .selectNoFrom(sql<string>`uuidv7()`.as('id'))
        .executeTakeFirstOrThrow();
      await storage.put(id, createReadStream(path), { size: inspected.size, contentType });
      staged.set(id, {
        filename,
        format,
        contentType,
        size: inspected.size,
        sha256: inspected.sha256,
      });
      return {
        id,
        format,
        async discard() {
          staged.delete(id);
          await storage.delete(id);
        },
      };
    },

    async keepStaged(trx, command, stagedId, keep) {
      const businessId = requireBusiness(command.context);
      const document = staged.get(stagedId);
      if (document === undefined)
        throw new ValidationError([
          {
            path: '/staged',
            code: 'not_found',
            message: 'There is no upload waiting with this id.',
          },
        ]);
      if (!keep.formats.includes(document.format))
        throw new ValidationError([
          {
            path: '/filename',
            code: 'unsupported_type',
            message: 'This file is not of a format the field takes now.',
          },
        ]);
      await checkBusinessQuota(trx, businessId, document.size, businessQuotaBytes);
      const row = await trx
        .insertInto('files.files')
        .values({
          id: stagedId,
          agency_id: command.context.agencyId,
          business_id: businessId,
          storage: storage.kind,
          storage_key: stagedId,
          filename: document.filename,
          content_type: document.contentType,
          size_bytes: document.size,
          sha256: document.sha256,
          uploaded_by_kind: command.context.actorKind,
          uploaded_by_id: command.context.actorId ?? null,
          purpose: keep.purpose,
        })
        .returning(columns)
        .executeTakeFirstOrThrow();
      // Kept once: a second command for it finds nothing waiting.
      staged.delete(stagedId);
      // A document's name can say whose it is: the event keeps its type and size only.
      await command.emit({
        type: 'file.uploaded',
        subject: { kind: 'file', id: stagedId },
        payload: { contentType: document.contentType, size: document.size, document: true },
      });
      return asStoredFile(row);
    },

    async discard(trx, command, fileId) {
      requireBusiness(command.context);
      const row = await trx
        .updateTable('files.files')
        .set({ deleted_at: sql`now()`, public_key: null, folder_id: null })
        .where('id', '=', fileId)
        .where('deleted_at', 'is', null)
        .returning(['id', 'size_bytes'])
        .executeTakeFirst();
      if (row === undefined) throw new NotFoundError('file', toPublicId('file', fileId));
      await command.emit({
        type: 'file.deleted',
        subject: { kind: 'file', id: row.id },
        payload: { size: Number(row.size_bytes) },
      });
    },

    tasks: [removeBytes],

    async store(trx, command, file) {
      const { context } = command;
      const content = Buffer.from(file.content);
      if (content.length > maxBytes) throw new ContentTooLargeError(maxBytes);
      const { contentType } = checkType(file.contentType, content.subarray(0, HEAD_BYTES));
      // The name is held to what an upload's is.
      const { filename } = parseInput(createFileInput.pick({ filename: true }), {
        filename: file.filename,
      });
      if (file.quota === true)
        await checkBusinessQuota(trx, requireBusiness(context), content.length, businessQuotaBytes);
      // The id comes first: it's the storage key too.
      const { id } = await trx
        .selectNoFrom(sql<string>`uuidv7()`.as('id'))
        .executeTakeFirstOrThrow();
      const row = await trx
        .insertInto('files.files')
        .values({
          id,
          agency_id: context.agencyId,
          business_id: context.businessId ?? null,
          storage: storage.kind,
          storage_key: id,
          filename,
          content_type: contentType,
          size_bytes: content.length,
          sha256: createHash('sha256').update(content).digest(),
          uploaded_by_kind: context.actorKind,
          uploaded_by_id: context.actorId ?? null,
          ...(file.purpose === undefined ? {} : { purpose: file.purpose }),
        })
        .returning(columns)
        .executeTakeFirstOrThrow();
      // Stored after the row, so a failure here rolls the row back with it. Bytes whose
      // command fails later stay in storage under an id no row names.
      await storage.put(id, Readable.from([content]), { size: content.length, contentType });
      await command.emit({
        type: 'file.uploaded',
        subject: { kind: 'file', id },
        payload: { filename: row.filename, contentType, size: content.length, generated: true },
      });
      return asStoredFile(row);
    },

    async open(db, { fileId, query, now, correlationId }) {
      const id = parsePublicId('file', fileId);
      if (id === undefined) return { refused: 'not_found' };
      const check = checkFileLink(linkSecret, id, query, now);
      if (!check.valid) return { refused: check.reason };
      // Read in the scope the link names, so row-level security keeps it to that scope.
      const row = await withTenant(
        db,
        {
          agencyId: check.scope.agencyId,
          ...(check.scope.businessId === undefined ? {} : { businessId: check.scope.businessId }),
          actorKind: 'system',
          correlationId,
        },
        (trx) => readFile(trx, id),
      );
      if (row === undefined) return { refused: 'not_found' };
      const body = await storage.get(row.storage_key);
      if (body === undefined) throw new Error(`The bytes of file ${fileId} are missing.`);
      return {
        body,
        filename: row.filename,
        contentType: row.content_type,
        size: Number(row.size_bytes),
        inline: showsInline(row.content_type),
      };
    },
  };
}
