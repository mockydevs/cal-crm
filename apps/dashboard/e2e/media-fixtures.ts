// Stands in for the server's Media Storage API: a library kept in the test's memory,
// answered as the contract says, so a page can upload, move, rename and delete and see what
// it did.
import type { Page, Route } from '@playwright/test';
import { mediaKindOf, type MediaFile, type MediaFolder, type MediaSort } from '@repo/contracts';

/** Where the stand-in's own addresses live: the page's origin, so nothing leaves the test. */
const ORIGIN = 'http://127.0.0.1:4173';

/** A one-pixel PNG, for every thumbnail and preview. */
export const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

export interface MediaLibrary {
  files: MediaFile[];
  folders: MediaFolder[];
  canManage: boolean;
  /** What the page sent that changed something, in order. */
  readonly changes: { readonly operation: string; readonly input: unknown }[];
  /** How long an upload takes to be answered, so its progress row can be seen. */
  uploadDelay: number;
}

let serial = 0;
/** A public id of the kind, unlike any other the stand-in made. */
function newId(prefix: 'file' | 'mfld'): string {
  serial += 1;
  // The example id of the contracts with its last four characters replaced: they are the
  // low bits of the UUID inside, so it stays a UUIDv7, as the SDK checks.
  return `${prefix}_01h455vb4pex5vsknk084s${String(serial).padStart(4, '0')}`;
}

export function mediaFileOf(
  name: string,
  contentType: string,
  rest: Partial<MediaFile> = {},
): MediaFile {
  const id = rest.id ?? newId('file');
  const kind = mediaKindOf(contentType);
  return {
    id,
    name,
    contentType,
    kind,
    size: 15_360,
    folderId: null,
    public: false,
    publicUrl: null,
    previewUrl:
      kind === 'document' && contentType !== 'application/pdf'
        ? null
        : `${ORIGIN}/m/p/${id}?agency=a&expires=1&signature=s`,
    createdAt: '2026-10-11T09:00:00.000Z',
    updatedAt: '2026-10-11T09:00:00.000Z',
    ...rest,
  };
}

export function mediaFolderOf(name: string, rest: Partial<MediaFolder> = {}): MediaFolder {
  return {
    id: rest.id ?? newId('mfld'),
    parentId: null,
    name,
    fileCount: 0,
    createdAt: '2026-10-11T09:00:00.000Z',
    updatedAt: '2026-10-11T09:00:00.000Z',
    ...rest,
  };
}

const problem = (route: Route, status: number, detail: string): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/problem+json',
    body: JSON.stringify({ type: 'about:blank', title: 'Refused', status, detail }),
  });

const order: Readonly<Record<MediaSort, (a: MediaFile, b: MediaFile) => number>> = {
  modified_desc: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  modified_asc: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
  name_asc: (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  name_desc: (a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase()),
  size_desc: (a, b) => b.size - a.size,
  size_asc: (a, b) => a.size - b.size,
};

/** Answers the media API from a library the test may read and change. */
export async function fakeMediaApi(
  page: Page,
  start: Partial<Pick<MediaLibrary, 'files' | 'folders' | 'canManage'>> = {},
): Promise<MediaLibrary> {
  const library: MediaLibrary = {
    files: start.files ?? [],
    folders: start.folders ?? [],
    canManage: start.canManage ?? true,
    changes: [],
    uploadDelay: 0,
  };
  let clock = Date.parse('2026-10-12T09:00:00.000Z');
  const now = (): string => {
    clock += 1000;
    return new Date(clock).toISOString();
  };
  const counted = (): MediaFolder[] =>
    library.folders.map((folder) => ({
      ...folder,
      fileCount: library.files.filter((file) => file.folderId === folder.id).length,
    }));

  await page.route(/\/api\/v1\/media(?:\?.*)?$/, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const folder = query.get('folder');
    const search = query.get('search')?.toLowerCase();
    const kind = query.get('kind');
    const sort = (query.get('sort') ?? 'modified_desc') as MediaSort;
    const items = library.files
      .filter((file) => folder === null || file.folderId === (folder === 'root' ? null : folder))
      .filter((file) => search === undefined || file.name.toLowerCase().includes(search))
      .filter((file) => kind === null || file.kind === kind)
      .filter((file) => query.get('visibility') !== 'public' || file.public)
      .sort(order[sort]);
    await route.fulfill({
      json: { canManage: library.canManage, canPublish: true, items, nextCursor: null },
    });
  });
  await page.route('**/api/v1/media/usage', (route) =>
    route.fulfill({
      json: {
        files: library.files.length,
        bytes: library.files.reduce((sum, file) => sum + file.size, 0),
        businessBytes: library.files.reduce((sum, file) => sum + file.size, 0),
        quotaBytes: null,
        maxFileBytes: 26_214_400,
      },
    }),
  );
  await page.route('**/api/v1/media/move', async (route) => {
    const input = route.request().postDataJSON() as { ids: string[]; folderId: string | null };
    library.changes.push({ operation: 'moveMedia', input });
    library.files = library.files.map((file) =>
      input.ids.includes(file.id) ? { ...file, folderId: input.folderId, updatedAt: now() } : file,
    );
    await route.fulfill({ json: { count: input.ids.length } });
  });
  await page.route('**/api/v1/media/delete', async (route) => {
    const input = route.request().postDataJSON() as { ids: string[] };
    library.changes.push({ operation: 'deleteMedia', input });
    library.files = library.files.filter((file) => !input.ids.includes(file.id));
    await route.fulfill({ json: { count: input.ids.length } });
  });
  await page.route(/\/api\/v1\/media\/file_[^/?]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';
    const found = library.files.find((file) => file.id === id);
    if (found === undefined) {
      await problem(route, 404, `Media file ${id} was not found.`);
      return;
    }
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { ...found, sha256: 'ab'.repeat(32), usedIn: [] } });
      return;
    }
    const input = route.request().postDataJSON() as { name?: string; public?: boolean };
    library.changes.push({ operation: 'updateMediaFile', input: { id, ...input } });
    const name = input.name ?? found.name;
    const isPublic = input.public ?? found.public;
    const changed: MediaFile = {
      ...found,
      name,
      public: isPublic,
      publicUrl: isPublic ? `${ORIGIN}/m/AbCdEfGhIjKlMnOpQrStUv/${encodeURIComponent(name)}` : null,
      updatedAt: now(),
    };
    library.files = library.files.map((file) => (file.id === id ? changed : file));
    await route.fulfill({ json: changed });
  });
  await page.route('**/api/v1/media-folders', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { canManage: library.canManage, items: counted() } });
      return;
    }
    const input = route.request().postDataJSON() as { name: string; parentId: string | null };
    library.changes.push({ operation: 'createMediaFolder', input });
    if (
      library.folders.some(
        (folder) =>
          folder.parentId === input.parentId &&
          folder.name.toLowerCase() === input.name.toLowerCase(),
      )
    ) {
      await problem(route, 409, 'A folder with that name already exists there.');
      return;
    }
    const made = mediaFolderOf(input.name, { parentId: input.parentId });
    library.folders = [...library.folders, made];
    await route.fulfill({ status: 201, json: made });
  });
  await page.route(/\/api\/v1\/media-folders\/mfld_[^/?]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';
    const found = library.folders.find((folder) => folder.id === id);
    if (found === undefined) {
      await problem(route, 404, `Media folder ${id} was not found.`);
      return;
    }
    if (route.request().method() === 'DELETE') {
      library.changes.push({ operation: 'removeMediaFolder', input: { id } });
      library.files = library.files.map((file) =>
        file.folderId === id ? { ...file, folderId: found.parentId } : file,
      );
      library.folders = library.folders
        .filter((folder) => folder.id !== id)
        .map((folder) =>
          folder.parentId === id ? { ...folder, parentId: found.parentId } : folder,
        );
      await route.fulfill({ status: 204 });
      return;
    }
    const input = route.request().postDataJSON() as { name?: string; parentId?: string | null };
    library.changes.push({ operation: 'updateMediaFolder', input: { id, ...input } });
    const changed = {
      ...found,
      name: input.name ?? found.name,
      parentId: input.parentId === undefined ? found.parentId : input.parentId,
    };
    library.folders = library.folders.map((folder) => (folder.id === id ? changed : folder));
    await route.fulfill({ json: { ...changed, fileCount: 0 } });
  });
  // An upload into the library, as the page sends it: the file's bytes, its name in the query.
  await page.route(/\/api\/v1\/files\?.*library=true/, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const name = query.get('filename') ?? '';
    const contentType = route.request().headers()['content-type'] ?? '';
    library.changes.push({
      operation: 'uploadFile',
      input: { name, contentType, folder: query.get('folder') },
    });
    if (library.uploadDelay > 0)
      await new Promise((resolve) => setTimeout(resolve, library.uploadDelay));
    const made = mediaFileOf(name, contentType, {
      folderId: query.get('folder'),
      size: route.request().postDataBuffer()?.length ?? 0,
      createdAt: now(),
      updatedAt: now(),
    });
    library.files = [...library.files, made];
    await route.fulfill({
      status: 201,
      json: {
        id: made.id,
        filename: made.name,
        contentType,
        size: made.size,
        sha256: 'ab'.repeat(32),
        createdAt: made.createdAt,
      },
    });
  });
  await page.route(/\/api\/v1\/files\/file_[^/]+\/links$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    library.changes.push({ operation: 'createFileLink', input: route.request().postDataJSON() });
    await route.fulfill({
      status: 201,
      json: {
        url: `${ORIGIN}/api/v1/files/${id}/content?agency=a&expires=1&signature=s`,
        expiresAt: '2026-10-19T09:00:00.000Z',
      },
    });
  });
  // Every thumbnail and preview is the same pixel; a PDF's is a page that says so.
  await page.route('**/m/p/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: PIXEL }),
  );
  return library;
}
