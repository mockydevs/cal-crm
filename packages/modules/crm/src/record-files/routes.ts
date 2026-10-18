// A record's files over the API: the Documents panel's list, an upload to the record or to
// one of its file upload fields, deleting an uploaded file, and a short-lived signed link
// to open one, given only to someone who can see the record.
import { Readable } from 'node:stream';

import {
  requireBusiness,
  requirePermission,
  runCommand,
  type ApiRoute,
  type Route,
} from '@repo/commands';
import {
  createRecordFileLink,
  deleteRecordFile,
  documentFormatOf,
  documentFormats,
  RECORD_FILE_LINK_SECONDS,
  listRecordFiles,
  listRecordFilesQuery,
  parseInput,
  uploadRecordFile,
  uploadRecordFileQuery,
  type DocumentFormat,
  type FileLink,
  type RecordFile,
  type RecordFilesPage,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import {
  actorKinds,
  ConflictError,
  ContentTooLargeError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type ActorKind,
} from '@repo/kernel';
import { sql } from 'kysely';

import type { ActorNames } from '../activity/activity.js';
import { containing, decodeCursor, encodeCursor } from '../custom-values/custom-values.js';
import { requireRecord } from '../records/access.js';
import {
  createRecordFileCommands,
  fieldFull,
  fileField,
  requireValues,
  type RecordFileStore,
} from './record-files.js';

/** A name whose format is not one of those taken. */
const unsupportedFormat = (formats: readonly DocumentFormat[]): ValidationError =>
  new ValidationError([
    {
      path: '/filename',
      code: 'unsupported_type',
      message: `Upload a file of one of these formats: ${formats.map((format) => format.toUpperCase()).join(', ')}.`,
    },
  ]);

/** A file attached to a message of a contact's conversation. */
export interface MessageAttachment {
  /** files.files.id. */
  readonly fileId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  /** When it was attached, in UTC to the microsecond: YYYY-MM-DDTHH:MM:SS.ffffffZ. */
  readonly attachedAt: string;
  readonly direction: 'inbound' | 'outbound';
  readonly authorKind: ActorKind;
  readonly authorId: string | null;
}

/** A contact's message attachments: the messaging module's to read, in the caller's transaction. */
export interface MessageAttachments {
  /** Newest first, after a place when given, each file once. */
  list(
    trx: DatabaseTransaction,
    query: {
      readonly contactId: string;
      readonly direction: 'inbound' | 'outbound' | undefined;
      readonly q: string | undefined;
      readonly limit: number;
      readonly after: { readonly at: string; readonly fileId: string } | undefined;
    },
  ): Promise<readonly MessageAttachment[]>;
  /** Whether the file is attached to a message of the contact's conversation. */
  has(trx: DatabaseTransaction, contactId: string, fileId: string): Promise<boolean>;
}

export interface RecordFileOptions {
  /** The files service, where this role has one. Without it nothing is uploaded or deleted. */
  readonly store?: RecordFileStore | undefined;
  /** A contact's message attachments, for Sent and Received. Without it those are empty. */
  readonly messageAttachments?: MessageAttachments | undefined;
  readonly actorNames: ActorNames;
  /** The API's address (PUBLIC_URL/api/v1), which a link starts with. Without it, no links. */
  readonly apiUrl?: string | undefined;
}

/** An instant as both sources write it: UTC to the microsecond, so text order is time order. */
export const INSTANT_TEXT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

const unavailable = () =>
  new ValidationError([
    {
      path: '',
      code: 'files_unavailable',
      message: "This server keeps no files: whoever runs it hasn't set up file storage.",
    },
  ]);

/** The body the server hands an upload route; anything else is a fault in the server. */
function streamOf(body: unknown): { stream: Readable; contentLength: number | undefined } {
  if (
    typeof body === 'object' &&
    body !== null &&
    'stream' in body &&
    body.stream instanceof Readable
  )
    return {
      stream: body.stream,
      contentLength:
        'contentLength' in body && typeof body.contentLength === 'number'
          ? body.contentLength
          : undefined,
    };
  throw new Error('uploadRecordFile takes the request body unread, as an UploadBody.');
}

/** One row of the merged list, before names are added. */
interface Row {
  readonly fileId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly at: string;
  readonly folder: RecordFile['folder'];
  readonly field: {
    readonly id: string;
    readonly label: string;
    /** An archived field's files stay as they are until it is restored. */
    readonly archived: boolean;
  } | null;
  readonly addedByKind: ActorKind;
  readonly addedById: string | null;
}

/** Newest first; the file's id decides between two of the same instant. */
const newerFirst = (a: Row, b: Row): number => {
  const [one, other] = [`${a.at} ${a.fileId}`, `${b.at} ${b.fileId}`];
  return one === other ? 0 : one < other ? 1 : -1;
};

export function recordFileRoutes(options: RecordFileOptions): readonly ApiRoute[] {
  const { store, messageAttachments, actorNames, apiUrl } = options;
  const commands =
    store === undefined
      ? createRecordFileCommands({
          maxBytes: 0,
          receive: () => Promise.reject(unavailable()),
          stageDocument: () => Promise.reject(unavailable()),
          keepStaged: () => Promise.reject(unavailable()),
          link: () => Promise.reject(unavailable()),
        })
      : createRecordFileCommands(store);

  const list = {
    endpoint: listRecordFiles,
    run: async ({ invocation, params, query }, { db }): Promise<RecordFilesPage> => {
      requireBusiness(invocation.context);
      const { id } = parseInput(listRecordFiles.params, params);
      const wanted = parseInput(listRecordFilesQuery, query);
      const after =
        wanted.after === undefined
          ? undefined
          : (() => {
              const [at, fileId] = decodeCursor(wanted.after);
              return { at, fileId };
            })();
      return withTenant(db, invocation.context, async (trx) => {
        const record = await requireRecord(trx, id);
        const grants = invocation.permissions;
        const may = (permission: 'files.upload' | 'fields.values') =>
          grants === 'all' || grants.has(permission);
        const canUpload = !record.trashed && may('files.upload');
        const rows: Row[] = [];
        if (wanted.folder === 'all' || wanted.folder === 'internal') {
          let own = trx
            .selectFrom('crm.record_files as r')
            .innerJoin('files.files as f', (join) =>
              join.onRef('f.business_id', '=', 'r.business_id').onRef('f.id', '=', 'r.file_id'),
            )
            .leftJoin('crm.field_definitions as d', (join) =>
              join.onRef('d.business_id', '=', 'r.business_id').onRef('d.id', '=', 'r.field_id'),
            )
            .select([
              'r.file_id',
              'f.filename',
              'f.content_type',
              'f.size_bytes',
              'r.field_id',
              'd.label as field_label',
              'd.archived_at as field_archived_at',
              'r.created_by_kind',
              'r.created_by_id',
            ])
            .select(sql<string>`to_char(r.created_at at time zone 'UTC', ${INSTANT_TEXT})`.as('at'))
            .where('r.record_id', '=', record.id)
            .where('f.deleted_at', 'is', null);
          if (wanted.q !== undefined && wanted.q !== '')
            own = own.where('f.filename', 'ilike', containing(wanted.q));
          if (wanted.field !== undefined)
            own = own.where('r.field_id', '=', parsePublicId('field', wanted.field) ?? '');
          if (after !== undefined)
            own = own.where(
              sql<boolean>`(r.created_at, r.file_id) < (${after.at}::timestamptz, ${after.fileId}::uuid)`,
            );
          const found = await own
            .orderBy('r.created_at', 'desc')
            .orderBy('r.file_id', 'desc')
            .limit(wanted.limit + 1)
            .execute();
          for (const row of found)
            rows.push({
              fileId: row.file_id,
              filename: row.filename,
              contentType: row.content_type,
              size: Number(row.size_bytes),
              at: row.at,
              folder: 'internal',
              field:
                row.field_id === null
                  ? null
                  : {
                      id: row.field_id,
                      label: row.field_label ?? '',
                      archived: row.field_archived_at !== null,
                    },
              addedByKind: actorKinds.find((kind) => kind === row.created_by_kind) ?? 'system',
              addedById: row.created_by_id,
            });
        }
        // A field's own list holds uploads only.
        if (
          record.kind === 'contact' &&
          messageAttachments !== undefined &&
          wanted.folder !== 'internal' &&
          wanted.field === undefined
        ) {
          const attachments = await messageAttachments.list(trx, {
            contactId: record.id,
            direction:
              wanted.folder === 'sent'
                ? 'outbound'
                : wanted.folder === 'received'
                  ? 'inbound'
                  : undefined,
            q: wanted.q,
            limit: wanted.limit + 1,
            after,
          });
          for (const each of attachments)
            rows.push({
              fileId: each.fileId,
              filename: each.filename,
              contentType: each.contentType,
              size: each.size,
              at: each.attachedAt,
              folder: each.direction === 'inbound' ? 'received' : 'sent',
              field: null,
              addedByKind: each.authorKind,
              addedById: each.authorId,
            });
        }
        rows.sort(newerFirst);
        const page = rows.slice(0, wanted.limit);
        const last = page.at(-1);
        // Names of who added each, as far as the reader may see them.
        const names = new Map<string, string>();
        const byKind = new Map<ActorKind, Set<string>>();
        for (const row of page)
          if (row.addedById !== null)
            byKind.set(
              row.addedByKind,
              (byKind.get(row.addedByKind) ?? new Set()).add(row.addedById),
            );
        for (const [kind, ids] of byKind) {
          const lookup = actorNames[kind];
          if (lookup === undefined) continue;
          for (const [actorId, name] of await lookup(trx, [...ids]))
            names.set(`${kind}:${actorId}`, name);
        }
        const context = invocation.context;
        return {
          canUpload,
          next:
            rows.length > wanted.limit && last !== undefined
              ? encodeCursor(last.at, last.fileId)
              : null,
          items: page.map((row) => ({
            id: toFileId(row.fileId),
            filename: row.filename,
            contentType: row.contentType,
            size: row.size,
            createdAt: new Date(row.at).toISOString(),
            folder: row.folder,
            field:
              row.field === null ? null : { id: toFieldId(row.field.id), label: row.field.label },
            addedBy: {
              kind: row.addedByKind,
              name:
                row.addedById === null
                  ? null
                  : (names.get(`${row.addedByKind}:${row.addedById}`) ?? null),
              you:
                row.addedByKind === 'user' &&
                context.userId !== undefined &&
                row.addedById === context.userId &&
                context.actorId === context.userId,
            },
            removable:
              canUpload &&
              row.folder === 'internal' &&
              (row.field === null || (may('fields.values') && !row.field.archived)),
          })),
        };
      });
    },
  } satisfies Route<typeof listRecordFiles>;

  const upload = {
    endpoint: uploadRecordFile,
    command: commands.attach,
    run: async ({ invocation, params, query, body }, services): Promise<RecordFile> => {
      requireBusiness(invocation.context);
      const { id } = parseInput(uploadRecordFile.params, params);
      // Before a byte is received, and before the query is read: another business's record
      // is not found.
      const record = await withTenant(services.db, invocation.context, (trx) =>
        requireRecord(trx, id),
      );
      const { filename, field } = parseInput(uploadRecordFileQuery, query);
      // What can be told without the bytes is told before them, and without holding any
      // row: the field, the format the name says, the role, the trash, a full field. The
      // command checks each again, under its locks.
      const formats = await withTenant(services.db, invocation.context, async (trx) => {
        if (field === undefined) return documentFormats;
        const definition = await fileField(trx, record.objectTypeId, field, false);
        const held = await trx
          .selectFrom('crm.record_files')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('record_id', '=', record.id)
          .where('field_id', '=', parsePublicId('field', definition.id) ?? '')
          .executeTakeFirstOrThrow();
        const limit = definition.files?.limit ?? 1;
        if (Number(held.count) >= limit) throw fieldFull(limit);
        return definition.files?.formats ?? documentFormats;
      });
      await requirePermission(services, commands.attach, invocation);
      if (field !== undefined) requireValues(invocation);
      if (record.trashed) throw new ConflictError('Restore this record before changing it.');
      const format = documentFormatOf(filename);
      if (format === undefined || !formats.includes(format)) throw unsupportedFormat(formats);
      if (store === undefined) throw unavailable();
      const { stream, contentLength } = streamOf(body);
      if (contentLength !== undefined && contentLength > store.maxBytes)
        throw new ContentTooLargeError(store.maxBytes);
      const received = await store.receive(stream);
      try {
        // Checked by its bytes and stored before the command holds the record.
        const staged = await store.stageDocument(services, received.upload, { filename, formats });
        try {
          return await runCommand(
            services,
            commands.attach,
            { id, staged: staged.id, ...(field === undefined ? {} : { field }) },
            invocation,
          );
        } catch (error) {
          // Not kept: its bytes go, rather than wait in storage with no row.
          await staged.discard();
          throw error;
        }
      } finally {
        await received.discard();
      }
    },
  } satisfies Route<typeof uploadRecordFile>;

  const remove = {
    endpoint: deleteRecordFile,
    command: commands.remove,
    run: async ({ invocation, params }, services): Promise<undefined> => {
      requireBusiness(invocation.context);
      const parsed = parseInput(deleteRecordFile.params, params);
      await withTenant(services.db, invocation.context, (trx) => requireRecord(trx, parsed.id));
      await runCommand(services, commands.remove, parsed, invocation);
      return undefined;
    },
  } satisfies Route<typeof deleteRecordFile>;

  const link = {
    endpoint: createRecordFileLink,
    run: async ({ invocation, params }, services): Promise<FileLink> => {
      requireBusiness(invocation.context);
      const parsed = parseInput(createRecordFileLink.params, params);
      // The record must be one the reader can see, and the file one of its own: an upload,
      // kept for the record alone, or an attachment of its conversation.
      const uploaded = await withTenant(services.db, invocation.context, async (trx) => {
        const record = await requireRecord(trx, parsed.id);
        const fileId = parsePublicId('file', parsed.fileId) ?? '';
        const own = await trx
          .selectFrom('crm.record_files')
          .select('file_id')
          .where('record_id', '=', record.id)
          .where('file_id', '=', fileId)
          .executeTakeFirst();
        const attached =
          own === undefined && record.kind === 'contact' && messageAttachments !== undefined
            ? await messageAttachments.has(trx, record.id, fileId)
            : own !== undefined;
        if (!attached) throw new NotFoundError('File', parsed.fileId);
        return own !== undefined;
      });
      if (store === undefined || apiUrl === undefined) throw unavailable();
      const made = await store.link(services, invocation, parsed.fileId, {
        seconds: RECORD_FILE_LINK_SECONDS,
        ...(uploaded ? { purpose: 'record_file' as const } : {}),
      });
      return { url: `${apiUrl}${made.path}`, expiresAt: made.expiresAt };
    },
  } satisfies Route<typeof createRecordFileLink>;

  return [list, upload, remove, link];
}

const toFileId = (id: string): string => toPublicId('file', id);
const toFieldId = (id: string): string => toPublicId('field', id);
