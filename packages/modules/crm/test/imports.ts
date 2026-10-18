// What the import tests share: a files service that keeps bytes in memory and their rows in
// files.files, as the real one does (the CRM module does not depend on the files module:
// the server hands it over), and ways to start an import and run its job as the worker does.
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { ApiRoute, Invocation, Services } from '@repo/commands';
import type { Permission, StoredFile } from '@repo/contracts';
import { withTenant, type Database } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';

import {
  createImportRoutes,
  createImportTasks,
  type ImportFiles,
  type ImportProgress,
  type ImportRouteOptions,
} from '../src/index.js';

export const API_URL = 'https://crm.example.test/api/v1';

export interface StoredBytes {
  readonly bytes: Buffer;
  readonly filename: string;
  readonly contentType: string;
}

/** A files service for tests: rows in files.files under row-level security, bytes here. */
export function memoryFiles(db: Database): ImportFiles & {
  /** Every stored file's bytes, by the file's stored id. */
  readonly stored: Map<string, StoredBytes>;
  /** How many times a stored file was opened to be read. */
  readonly opened: string[];
} {
  const stored = new Map<string, StoredBytes>();
  const opened: string[] = [];
  return {
    stored,
    opened,
    async content(_services, invocation, fileId) {
      const id = parsePublicId('file', fileId);
      const row =
        id === undefined
          ? undefined
          : await withTenant(db, invocation.context, (trx) =>
              trx
                .selectFrom('files.files')
                .select(['id', 'business_id', 'filename', 'content_type', 'size_bytes', 'sha256'])
                .select('created_at')
                .where('id', '=', id)
                .where('deleted_at', 'is', null)
                .executeTakeFirst(),
            );
      if (row === undefined) return undefined;
      return {
        file: {
          id: toPublicId('file', row.id),
          filename: row.filename,
          contentType: row.content_type,
          size: Number(row.size_bytes),
          sha256: row.sha256.toString('hex'),
          createdAt: row.created_at.toISOString(),
        },
        shared: row.business_id === null,
        open() {
          const found = stored.get(row.id);
          if (found === undefined) return Promise.reject(new Error('The bytes are missing.'));
          opened.push(row.id);
          // In pieces, as a disk or a bucket hands a file over.
          const pieces: Buffer[] = [];
          for (let at = 0; at < found.bytes.length; at += 4096)
            pieces.push(found.bytes.subarray(at, at + 4096));
          return Promise.resolve(Readable.from(pieces));
        },
      };
    },
    async upload(_services, invocation, upload): Promise<StoredFile> {
      const chunks: Buffer[] = [];
      for await (const chunk of upload.body)
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
      const bytes = Buffer.concat(chunks);
      const sha256 = createHash('sha256').update(bytes).digest();
      const contentType = upload.contentType ?? 'application/octet-stream';
      const row = await withTenant(db, invocation.context, (trx) =>
        trx
          .insertInto('files.files')
          .values({
            agency_id: invocation.context.agencyId,
            business_id: invocation.context.businessId ?? null,
            storage: 'local',
            storage_key: randomUUID(),
            filename: upload.filename,
            content_type: contentType,
            size_bytes: bytes.length,
            sha256,
            uploaded_by_kind: invocation.context.actorKind,
            uploaded_by_id: invocation.context.actorId ?? null,
          })
          .returning(['id', 'created_at'])
          .executeTakeFirstOrThrow(),
      );
      stored.set(row.id, { bytes, filename: upload.filename, contentType });
      return {
        id: toPublicId('file', row.id),
        filename: upload.filename,
        contentType,
        size: bytes.length,
        sha256: sha256.toString('hex'),
        createdAt: row.created_at.toISOString(),
      };
    },
    link(_services, _invocation, fileId, { seconds }) {
      return Promise.resolve({
        path: `/files/${fileId}/content?lasting=${String(seconds)}`,
        expiresAt: new Date(Date.UTC(2026, 9, 10, 12, 0, seconds)).toISOString(),
      });
    },
  };
}

export interface Workspace {
  readonly businessId: string;
  readonly agencyId: string;
  readonly userId: string;
  /** The business's owner, signed in: everything allowed. */
  readonly owner: Invocation;
  /** The same person with only these permissions. */
  as(permissions: readonly Permission[]): Invocation;
  /** The system working in the business, as a job of the worker does. */
  readonly system: Invocation;
}

/** A business of its own in a new agency, optionally in a country, and its owner. */
export async function workspace(
  database: TestDatabase,
  options: { country?: string; name?: string } = {},
): Promise<Workspace> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user(
    options.name === undefined ? {} : { name: options.name },
  );
  if (options.country !== undefined)
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update tenancy.businesses set address = jsonb_build_object('country', $2::text) where id = $1`,
        [business.id, options.country],
      ),
    );
  const context = {
    ...business.context,
    userId: user.id,
    actorKind: 'user' as const,
    actorId: user.id,
  };
  const acting = (permissions: Invocation['permissions']): Invocation => ({
    context: { ...context, correlationId: randomUUID() },
    permissions,
  });
  return {
    businessId: business.id,
    agencyId: agency.id,
    userId: user.id,
    owner: acting('all'),
    as: (permissions) => acting(new Set(permissions)),
    system: {
      context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
      permissions: 'all',
    },
  };
}

export const attribute = (name: string) => ({ kind: 'attribute', attribute: name }) as const;
export const customField = (fieldId: string) => ({ kind: 'field', fieldId }) as const;

/** The import API over a files service, called as the server calls a route. */
export function importApi(
  services: Services,
  files: ImportFiles,
  options: Partial<ImportRouteOptions> = {},
): {
  routes: readonly ApiRoute[];
  call(
    operationId: string,
    invocation: Invocation,
    request?: { body?: unknown; params?: unknown; query?: unknown },
  ): Promise<unknown>;
} {
  const routes: readonly ApiRoute[] = createImportRoutes({ files, apiUrl: API_URL, ...options });
  const call = (
    operationId: string,
    invocation: Invocation,
    request: { body?: unknown; params?: unknown; query?: unknown } = {},
  ): Promise<unknown> => {
    const route = routes.find((each) => each.endpoint.operationId === operationId);
    if (route === undefined) throw new Error(`No route ${operationId}.`);
    return route.run(
      {
        invocation,
        params: request.params ?? {},
        query: request.query ?? {},
        body: request.body ?? {},
      },
      services,
    );
  };
  return { routes, call };
}

/** Uploads text as a CSV file of the invocation's business. */
export function uploadCsv(
  files: ImportFiles,
  services: Services,
  invocation: Invocation,
  content: string | Buffer,
  filename = 'contacts.csv',
  contentType = 'text/csv',
): Promise<StoredFile> {
  return files.upload(services, invocation, {
    body: Readable.from([typeof content === 'string' ? Buffer.from(content, 'utf8') : content]),
    contentType,
    filename,
  });
}

/**
 * Runs an import's job once, as the worker runs it: as the system, in the import's
 * business. Gives what the run reported.
 */
export async function runImportJob(
  services: Services,
  files: ImportFiles | undefined,
  system: Invocation,
  importId: string,
  options: {
    batchSize?: number;
    outcomePageSize?: number;
    onProgress?: (progress: ImportProgress) => void | Promise<void>;
  } = {},
): Promise<ImportProgress[]> {
  const reported: ImportProgress[] = [];
  const [task] = createImportTasks({
    files,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.outcomePageSize === undefined ? {} : { outcomePageSize: options.outcomePageSize }),
    onProgress: async (progress) => {
      reported.push(progress);
      await options.onProgress?.(progress);
    },
  });
  if (task === undefined) throw new Error('There is no import task.');
  await task.run(
    { importId: parsePublicId('import', importId) ?? importId },
    { invocation: system, services },
  );
  return reported;
}
