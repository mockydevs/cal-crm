// The media library: a business's files that were uploaded to be shown, kept as rows of
// files.files and read here as a library. The bytes stay with the storage backend the files
// service uses; nothing here lists a bucket.
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  defineCommand,
  requireBusiness,
  type Command,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  deleteMediaInput,
  listMediaQuery,
  mediaKindOf,
  mediaUses,
  moveMediaInput,
  publicId,
  updateMediaFileInput,
  type MediaBulkResult,
  type MediaFile,
  type MediaFileDetail,
  type MediaFileList,
  type MediaFolderList,
  type MediaUsage,
  type MediaUse,
} from '@repo/contracts';
import { withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import type { ByteRange, Storage } from '@repo/storage';
import { sql } from 'kysely';
import type * as z from 'zod';

import { checkFileLink, signFileLink } from './links.js';
import {
  canManageMedia,
  createMediaFolderCommands,
  lockedFolder,
  readMediaFolders,
  type MediaFolderCommands,
} from './media-folders.js';
import {
  containsPattern,
  decodeCursor,
  encodeCursor,
  kindPatterns,
  PREVIEW_SECONDS,
  previewable,
  previewSignedFrom,
  publicInline,
  sortSpecs,
} from './media-rules.js';

/** Where the install answers a public or a preview address: under PUBLIC_URL. */
export const MEDIA_PATH = '/m';
/** A preview's address under it: /m/p/<file id>?<signed query>. */
export const MEDIA_PREVIEW_SEGMENT = 'p';

export interface MediaOptions {
  readonly storage: Storage;
  /** Signs preview addresses (FILES_LINK_SECRET), as it signs file links. */
  readonly linkSecret: string;
  /** The largest upload taken, in bytes: told to the page, enforced by the files service. */
  readonly maxBytes: number;
  /** The most a business's live files may add up to, when the install sets a limit. */
  readonly businessQuotaBytes?: number | undefined;
  /** PUBLIC_URL: what addresses are made under. */
  readonly publicUrl: string;
  /**
   * Whether this install answers public addresses (/m/<key>/<name>): it does where it has
   * the shared public rate limit. Without it no file can be made public.
   */
  readonly servesPublic: boolean;
  readonly now?: () => Date;
}

const updateInput = updateMediaFileInput.safeExtend({ id: publicId('file') });

/** A file found by an address, before any byte is read. */
export interface FoundMedia {
  readonly filename: string;
  readonly contentType: string;
  /** The whole file's size, in bytes. */
  readonly size: number;
  /** A strong validator: the bytes' SHA-256, quoted. */
  readonly etag: string;
  /** Shown in place (a picture, a video, a sound) rather than downloaded. */
  readonly inline: boolean;
  /** Opens the bytes, or the part asked for. Read the stream to its end, or destroy it. */
  open(range?: ByteRange): Promise<Readable>;
}

export type FoundPreview = FoundMedia | { readonly refused: 'invalid' | 'expired' | 'not_found' };

export interface Media {
  readonly commands: {
    readonly update: Command<typeof updateInput, MediaFile>;
    readonly move: Command<typeof moveMediaInput, MediaBulkResult>;
    readonly remove: Command<typeof deleteMediaInput, MediaBulkResult>;
  };
  readonly folders: MediaFolderCommands;
  list(services: Services, invocation: Invocation, query: unknown): Promise<MediaFileList>;
  read(services: Services, invocation: Invocation, fileId: string): Promise<MediaFileDetail>;
  usage(services: Services, invocation: Invocation): Promise<MediaUsage>;
  folderList(services: Services, invocation: Invocation): Promise<MediaFolderList>;
  /** The file a public address names; undefined for anything that is not public now. */
  findPublic(
    db: Database,
    request: { readonly key: string; readonly correlationId: string },
  ): Promise<FoundMedia | undefined>;
  /** The library file a signed preview address names. */
  findPreview(
    db: Database,
    request: {
      readonly fileId: string;
      readonly query: unknown;
      readonly now: Date;
      readonly correlationId: string;
    },
  ): Promise<FoundPreview>;
}

const columns = [
  'f.id',
  'f.agency_id',
  'f.business_id',
  'f.storage_key',
  'f.filename',
  'f.content_type',
  'f.size_bytes',
  'f.sha256',
  'f.folder_id',
  'f.public_key',
  'f.created_at',
  'f.updated_at',
] as const;

interface MediaRow {
  id: string;
  agency_id: string;
  business_id: string | null;
  storage_key: string;
  filename: string;
  content_type: string;
  size_bytes: string;
  sha256: Buffer;
  folder_id: string | null;
  public_key: string | null;
  created_at: Date;
  updated_at: Date;
}

const PUBLIC_KEY = /^[A-Za-z0-9_-]{22}$/;

/** Live library files, as the transaction's tenant context sees them. */
const library = (trx: DatabaseTransaction) =>
  trx
    .selectFrom('files.files as f')
    .where('f.library', '=', true)
    .where('f.deleted_at', 'is', null);

function readRow(trx: DatabaseTransaction, id: string): Promise<MediaRow | undefined> {
  return library(trx).select(columns).where('f.id', '=', id).executeTakeFirst();
}

/** A public file's address: the key finds it, the name is for people and an extension. */
const addressOf = (publicUrl: string, key: string, filename: string): string =>
  `${publicUrl}${MEDIA_PATH}/${key}/${encodeURIComponent(filename)}`;

/**
 * The public address of one live library file of the transaction's business, or null while
 * it has none: what a public page may show of a file, and nothing else of it.
 */
export async function publicMediaAddress(
  trx: DatabaseTransaction,
  publicUrl: string,
  fileId: string,
): Promise<string | null> {
  const row = await library(trx)
    .select(['f.public_key', 'f.filename'])
    .where('f.id', '=', fileId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return row.public_key === null ? null : addressOf(publicUrl, row.public_key, row.filename);
}

/** What every live file of the business adds up to, in bytes: what the quota counts. */
export async function businessBytes(trx: DatabaseTransaction, businessId: string): Promise<number> {
  const { bytes } = await trx
    .selectFrom('files.files')
    .select(sql<string>`coalesce(sum(size_bytes), 0)`.as('bytes'))
    .where('business_id', '=', businessId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(bytes);
}

/** Refuses an upload that would take the business past the install's quota. */
export async function checkBusinessQuota(
  trx: DatabaseTransaction,
  businessId: string,
  size: number,
  quotaBytes: number | undefined,
): Promise<void> {
  if (quotaBytes === undefined) return;
  // One writer at a time counts a business's bytes, until its transaction ends: two uploads
  // at once can't each fit in the room only one of them has.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`files.quota:${businessId}`}, 0))`.execute(
    trx,
  );
  const used = await businessBytes(trx, businessId);
  if (used + size > quotaBytes)
    throw new ValidationError([
      {
        path: '',
        code: 'storage_full',
        message: `This business's storage is full: it holds ${String(used)} of ${String(quotaBytes)} bytes. Delete files to make room.`,
      },
    ]);
}

const notFound = (id: string) => new NotFoundError('Media file', id);

const useNames: Readonly<Record<MediaUse, string>> = {
  business_logo: "the business's logo",
  agency_logo: "the agency's logo",
  user_picture: "a person's picture",
  calendar: 'a calendar',
  message_attachment: 'a message',
  import: 'an import',
  site_template: 'a site template',
  record_file: "a contact's or another record's files",
  contact_export: 'an export of contacts',
};

async function usedIn(trx: DatabaseTransaction, id: string): Promise<MediaUse[]> {
  const { rows } = await sql<{ place: string }>`
    select place from files.file_usage(${id}::uuid)
  `.execute(trx);
  return mediaUses.filter((use) => rows.some((row) => row.place === use));
}

export function createMedia(options: MediaOptions): Media {
  const { storage, linkSecret, publicUrl, servesPublic } = options;
  const now = options.now ?? (() => new Date());

  const present = (row: MediaRow): MediaFile => {
    const id = toPublicId('file', row.id);
    return {
      id,
      name: row.filename,
      contentType: row.content_type,
      kind: mediaKindOf(row.content_type),
      size: Number(row.size_bytes),
      folderId: row.folder_id === null ? null : toPublicId('media_folder', row.folder_id),
      public: row.public_key !== null,
      publicUrl:
        row.public_key === null ? null : addressOf(publicUrl, row.public_key, row.filename),
      previewUrl: previewable(row.content_type)
        ? `${publicUrl}${MEDIA_PATH}/${MEDIA_PREVIEW_SEGMENT}/${id}?${signFileLink(
            linkSecret,
            row.id,
            { agencyId: row.agency_id, businessId: row.business_id ?? undefined },
            { now: previewSignedFrom(now()), seconds: PREVIEW_SECONDS },
          )}`
        : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  };

  const found = (row: MediaRow, inline: boolean): FoundMedia => ({
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size_bytes),
    etag: `"${row.sha256.toString('hex')}"`,
    inline,
    async open(range) {
      const body = await storage.get(row.storage_key, range);
      if (body === undefined)
        throw new Error(`The bytes of file ${toPublicId('file', row.id)} are missing.`);
      return body;
    },
  });

  const update = defineCommand({
    name: 'media.update',
    permission: 'media.manage',
    input: updateInput,
    async handle(trx, input, command): Promise<MediaFile> {
      requireBusiness(command.context);
      const id = parsePublicId('file', input.id);
      const row = id === undefined ? undefined : await readRow(trx, id);
      if (row === undefined) throw notFound(input.id);
      if (input.public === true && !servesPublic)
        throw new ValidationError([
          {
            path: '/public',
            code: 'public_media_unavailable',
            message:
              "This install doesn't serve public files yet: it needs PUBLIC_INTAKE_SECRET set.",
          },
        ]);
      const renamed = input.name !== undefined && input.name !== row.filename;
      const published = input.public === true && row.public_key === null;
      const unpublished = input.public === false && row.public_key !== null;
      if (!renamed && !published && !unpublished) return present(row);
      const changed = await trx
        .updateTable('files.files as f')
        .set({
          ...(renamed ? { filename: input.name } : {}),
          // 128 random bits: the address can't be guessed, and is never given twice.
          ...(published ? { public_key: randomBytes(16).toString('base64url') } : {}),
          ...(unpublished ? { public_key: null } : {}),
        })
        .where('f.id', '=', row.id)
        .returning(columns)
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'file.updated',
        subject: { kind: 'file', id: row.id },
        payload: { renamed, published, unpublished },
      });
      return present(changed);
    },
  });

  const move = defineCommand({
    name: 'media.move',
    permission: 'media.manage',
    input: moveMediaInput,
    async handle(trx, input, command): Promise<MediaBulkResult> {
      const businessId = requireBusiness(command.context);
      const folderId = await lockedFolder(trx, businessId, input.folderId);
      const ids = input.ids.map((given) => parsePublicId('file', given) ?? '');
      const rows = await library(trx)
        .select(['f.id', 'f.folder_id'])
        .where('f.id', 'in', ids)
        .execute();
      const missing = input.ids.find((_given, index) => !rows.some((row) => row.id === ids[index]));
      if (missing !== undefined) throw notFound(missing);
      const moving = rows.filter((row) => row.folder_id !== folderId).map((row) => row.id);
      if (moving.length === 0) return { count: 0 };
      await trx
        .updateTable('files.files')
        .set({ folder_id: folderId })
        .where('id', 'in', moving)
        .execute();
      for (const id of moving)
        await command.emit({
          type: 'file.moved',
          subject: { kind: 'file', id },
          payload: { folderId: input.folderId },
        });
      return { count: moving.length };
    },
  });

  const remove = defineCommand({
    name: 'media.delete',
    permission: 'media.manage',
    input: deleteMediaInput,
    async handle(trx, input, command): Promise<MediaBulkResult> {
      requireBusiness(command.context);
      const ids = input.ids.map((given) => parsePublicId('file', given) ?? '');
      const rows = await library(trx)
        .select(['f.id', 'f.filename', 'f.storage_key', 'f.size_bytes'])
        .where('f.id', 'in', ids)
        .forUpdate()
        .execute();
      const missing = input.ids.find((_given, index) => !rows.some((row) => row.id === ids[index]));
      if (missing !== undefined) throw notFound(missing);
      for (const row of rows) {
        const uses = await usedIn(trx, row.id);
        if (uses.length > 0)
          throw new ConflictError(
            `"${row.filename}" is still used by ${uses.map((use) => useNames[use]).join(' and ')}. Remove it there first.`,
          );
      }
      await trx
        .updateTable('files.files')
        .set({ deleted_at: sql`now()`, public_key: null, folder_id: null })
        .where(
          'id',
          'in',
          rows.map((row) => row.id),
        )
        .execute();
      for (const row of rows)
        await command.emit({
          type: 'file.deleted',
          subject: { kind: 'file', id: row.id },
          payload: { filename: row.filename, size: Number(row.size_bytes) },
        });
      // The objects go last, so a storage service that refuses rolls every row back and
      // the files are still there to delete again. Removing one that is already gone is
      // fine, which is what makes that second try work.
      for (const row of rows) await storage.delete(row.storage_key);
      return { count: rows.length };
    },
  });

  return {
    commands: { update, move, remove },
    folders: createMediaFolderCommands(),

    list(services, invocation, given) {
      const businessId = requireBusiness(invocation.context);
      const query: z.output<typeof listMediaQuery> = listMediaQuery.parse(given);
      const spec = sortSpecs[query.sort];
      const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      if (query.cursor !== undefined && cursor?.sort !== query.sort)
        throw new ValidationError([
          {
            path: '/cursor',
            code: 'invalid_cursor',
            message: 'Send a nextCursor unchanged, with the sort it was read in.',
          },
        ]);
      const expression = sql.raw(spec.expression);
      const direction = sql.raw(spec.direction);
      const folderUuid =
        query.folder === undefined || query.folder === 'root'
          ? undefined
          : (parsePublicId('media_folder', query.folder) ?? '');
      return withTenant(services.db, invocation.context, async (trx) => {
        let rows = library(trx)
          .select(columns)
          .select(sql<string>`(${expression})::text`.as('sort_value'))
          .where('f.business_id', '=', businessId);
        if (query.folder === 'root') rows = rows.where('f.folder_id', 'is', null);
        if (folderUuid !== undefined) rows = rows.where('f.folder_id', '=', folderUuid);
        if (query.search !== undefined && query.search !== '')
          rows = rows.where(sql<boolean>`f.filename ilike ${containsPattern(query.search)}`);
        if (query.kind !== undefined) {
          const { kind } = query;
          rows =
            kind === 'document'
              ? rows.where(
                  sql<boolean>`not (f.content_type like any (${sql.val(Object.values(kindPatterns))}::text[]))`,
                )
              : rows.where(sql<boolean>`f.content_type like ${kindPatterns[kind]}`);
        }
        if (query.visibility === 'public') rows = rows.where('f.public_key', 'is not', null);
        if (cursor !== undefined)
          rows = rows.where(
            sql<boolean>`(${expression}, f.id) ${sql.raw(spec.direction === 'asc' ? '>' : '<')} (${cursor.value}::${sql.raw(spec.cast)}, ${cursor.id}::uuid)`,
          );
        const page = await rows
          .orderBy(sql`${expression} ${direction}`)
          .orderBy(sql`f.id ${direction}`)
          .limit(query.limit + 1)
          .execute();
        const items = page.slice(0, query.limit);
        const last = items.at(-1);
        return {
          canManage: canManageMedia(invocation),
          canPublish: servesPublic,
          items: items.map(present),
          nextCursor:
            page.length > query.limit && last !== undefined
              ? encodeCursor({ sort: query.sort, value: last.sort_value, id: last.id })
              : null,
        };
      });
    },

    read(services, invocation, fileId) {
      requireBusiness(invocation.context);
      const id = parsePublicId('file', fileId);
      return withTenant(services.db, invocation.context, async (trx) => {
        const row = id === undefined ? undefined : await readRow(trx, id);
        if (row === undefined) throw notFound(fileId);
        return {
          ...present(row),
          sha256: row.sha256.toString('hex'),
          usedIn: await usedIn(trx, row.id),
        };
      });
    },

    usage(services, invocation) {
      const businessId = requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, async (trx) => {
        const held = await library(trx)
          .select((eb) => eb.fn.countAll<string>().as('files'))
          .select(sql<string>`coalesce(sum(f.size_bytes), 0)`.as('bytes'))
          .where('f.business_id', '=', businessId)
          .executeTakeFirstOrThrow();
        return {
          files: Number(held.files),
          bytes: Number(held.bytes),
          businessBytes: await businessBytes(trx, businessId),
          quotaBytes: options.businessQuotaBytes ?? null,
          maxFileBytes: options.maxBytes,
        };
      });
    },

    folderList(services, invocation) {
      requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, (trx) =>
        readMediaFolders(trx, invocation),
      );
    },

    async findPublic(db, { key, correlationId }) {
      if (!PUBLIC_KEY.test(key)) return undefined;
      // The one way across businesses: a key names its file's business and agency, and
      // only while the file is public and the business active.
      const {
        rows: [named],
      } = await sql<{ agency_id: string; business_id: string; file_id: string }>`
        select agency_id, business_id, file_id from private.resolve_public_media(${key})
      `.execute(db);
      if (named === undefined) return undefined;
      const row = await withTenant(
        db,
        {
          agencyId: named.agency_id,
          businessId: named.business_id,
          actorKind: 'system',
          correlationId,
        },
        (trx) => readRow(trx, named.file_id),
      );
      // Read again under row-level security, and held to the key: made private since.
      if (row?.public_key !== key) return undefined;
      return found(row, publicInline(row.content_type));
    },

    async findPreview(db, { fileId, query, now: at, correlationId }) {
      const id = parsePublicId('file', fileId);
      if (id === undefined) return { refused: 'not_found' };
      const check = checkFileLink(linkSecret, id, query, at);
      if (!check.valid) return { refused: check.reason };
      const row = await withTenant(
        db,
        {
          agencyId: check.scope.agencyId,
          ...(check.scope.businessId === undefined ? {} : { businessId: check.scope.businessId }),
          actorKind: 'system',
          correlationId,
        },
        (trx) => readRow(trx, id),
      );
      if (row === undefined || !previewable(row.content_type)) return { refused: 'not_found' };
      return found(row, true);
    },
  };
}
