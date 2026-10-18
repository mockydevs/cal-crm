// What the two suites that try every endpoint need for Media Storage: a folder of a
// business and a library file, added directly so each test pays one statement; an input for
// each operation that the business's own member could send and have accepted; and an
// example of every command for the permission matrix.
import { toPublicId } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import type { LightMyRequestResponse } from 'fastify';

export interface MediaRecords {
  readonly media_folder: string;
  /** A library file in that folder. Its row only: nothing is in storage under its key. */
  readonly media_file: string;
}

/** A folder of the business with one library file in it. */
export async function addMediaRecords(
  database: TestDatabase,
  businessId: string,
): Promise<MediaRecords> {
  const row = await database.as('crm_owner', (sql) =>
    sql.one<{ folder: string; file: string }>(
      `with f as (
         insert into files.folders (business_id, name, created_by_kind)
         values ($1, 'Folder ' || uuidv7()::text, 'system') returning id
       ), i as (
         select uuidv7() as id
       ), m as (
         insert into files.files (id, agency_id, business_id, storage, storage_key, filename,
           content_type, size_bytes, sha256, uploaded_by_kind, library, folder_id)
         select i.id, b.agency_id, b.id, 'local', i.id::text, 'business-b-only.png', 'image/png',
           8, sha256('business b only'::bytea), 'system', true, f.id
         from tenancy.businesses b, f, i where b.id = $1 returning id
       )
       select f.id as folder, m.id as file from f, m`,
      [businessId],
    ),
  );
  return {
    media_folder: toPublicId('media_folder', row.folder),
    media_file: toPublicId('file', row.file),
  };
}

/**
 * What B's own member could send about B's library and have accepted. The file named by
 * path is `records.file`, which the suite uploads into the library.
 */
export function mediaInputs(
  records: Readonly<Record<string, string>>,
): Readonly<Record<string, { payload?: unknown; query?: string }>> {
  return {
    listMedia: { query: `?folder=${records['media_folder'] ?? ''}` },
    updateMediaFile: { payload: { name: 'Reached from A.txt' } },
    moveMedia: { payload: { ids: [records['file']], folderId: records['media_folder'] } },
    deleteMedia: { payload: { ids: [records['file']] } },
    createMediaFolder: { payload: { name: 'Reached from A', parentId: records['media_folder'] } },
    updateMediaFolder: { payload: { name: 'Reached from A' } },
  };
}

type Call = (
  method: 'POST' | 'PUT' | 'PATCH' | 'GET' | 'DELETE',
  path: string,
  options: { payload: unknown; type?: string; inBusiness: boolean },
) => Promise<LightMyRequestResponse>;

interface Example {
  readonly run: (call: Call, run: number) => Promise<LightMyRequestResponse>;
}

/** An example of every Media Storage command, each on records added for that try. */
export function mediaExamples(
  database: () => TestDatabase,
  business: () => string,
): Readonly<Record<string, Example>> {
  const fresh = (): Promise<MediaRecords> => addMediaRecords(database(), business());
  const here = (payload: unknown) => ({ inBusiness: true, payload });
  const name = (run: number): string => `Matrix ${String(run)}`;
  return {
    'media.update': {
      async run(call, run) {
        const records = await fresh();
        return call('PATCH', `/media/${records.media_file}`, here({ name: `${name(run)}.png` }));
      },
    },
    'media.move': {
      async run(call) {
        const records = await fresh();
        return call('POST', '/media/move', here({ ids: [records.media_file], folderId: null }));
      },
    },
    'media.delete': {
      async run(call) {
        const records = await fresh();
        return call('POST', '/media/delete', here({ ids: [records.media_file] }));
      },
    },
    'media.create_folder': {
      run: (call, run) => call('POST', '/media-folders', here({ name: name(run) })),
    },
    'media.update_folder': {
      async run(call, run) {
        const records = await fresh();
        return call('PATCH', `/media-folders/${records.media_folder}`, here({ name: name(run) }));
      },
    },
    'media.remove_folder': {
      async run(call) {
        const records = await fresh();
        return call('DELETE', `/media-folders/${records.media_folder}`, here(undefined));
      },
    },
  };
}

/** The names of the Media Storage commands: daily work, which a viewer alone may not do. */
export const MEDIA_COMMANDS: readonly string[] = Object.keys(
  mediaExamples(
    () => {
      throw new Error('Names only.');
    },
    () => '',
  ),
);
