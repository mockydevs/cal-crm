// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { MediaFile, MediaFolder, MediaKind } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  configure,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadOutcome, UploadRequest } from './data';
import { MediaStoragePage } from './page';
import MediaPicker from './picker';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('../api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('../workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('../shell/page', () => ({
  Page: ({
    title,
    actions,
    children,
  }: {
    title: string;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {children}
    </main>
  ),
}));

/** The uploads the page started, each ended by the test. */
interface Sent {
  readonly request: UploadRequest;
  end(outcome: UploadOutcome): void;
  cancelled: boolean;
}
const sent = vi.hoisted((): { list: Sent[] } => ({ list: [] }));
vi.mock('./data', async (original) => ({
  ...(await original<typeof import('./data')>()),
  sendUpload: (request: UploadRequest) => {
    let end: (outcome: UploadOutcome) => void = () => undefined;
    const done = new Promise<UploadOutcome>((resolve) => {
      end = resolve;
    });
    const upload: Sent = { request, end, cancelled: false };
    sent.list.push(upload);
    return {
      done,
      cancel() {
        upload.cancelled = true;
        end({ ok: false, failure: 'cancelled' });
      },
    };
  },
}));

// A busy machine (another lane's build, a two-core runner) answers late: wait longer for it.
configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 30000 });

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
  sent.list.length = 0;
});
afterEach(cleanup);

const at = '2026-10-11T09:00:00.000Z';
const id = (prefix: string, last: string) => `${prefix}_01h455vb4pex5vsknk084sn02${last}`;

function fileOf(last: string, name: string, rest: Partial<MediaFile> = {}): MediaFile {
  const kind: MediaKind = rest.kind ?? 'image';
  return {
    id: id('file', last),
    name,
    contentType: 'image/png',
    kind,
    size: 15_360,
    folderId: null,
    public: false,
    publicUrl: null,
    previewUrl: `https://crm.example.test/m/p/${id('file', last)}?signature=x`,
    createdAt: at,
    updatedAt: at,
    ...rest,
  };
}
const folderOf = (last: string, name: string, rest: Partial<MediaFolder> = {}): MediaFolder => ({
  id: id('mfld', last),
  parentId: null,
  name,
  fileCount: 0,
  createdAt: at,
  updatedAt: at,
  ...rest,
});

const front = fileOf('q', 'front.png');
const hero = fileOf('r', 'hero.png', {
  public: true,
  publicUrl: 'https://crm.example.test/m/AbCdEfGhIjKlMnOpQrStUv/hero.png',
  size: 2_621_440,
});
const tour = fileOf('s', 'tour.mp4', { kind: 'video', contentType: 'video/mp4' });
const jingle = fileOf('t', 'jingle.mp3', { kind: 'audio', contentType: 'audio/mpeg' });
const menu = fileOf('v', 'menu.pdf', { kind: 'document', contentType: 'application/pdf' });
const rows = fileOf('w', 'rows.csv', {
  kind: 'document',
  contentType: 'text/csv',
  previewUrl: null,
});
const brand = folderOf('q', 'Brand', { fileCount: 2 });
const logos = folderOf('r', 'Logos', { parentId: brand.id, fileCount: 1 });

function refusal(
  status: number,
  rest: { detail?: string; errors?: { path: string; code: string; message: string }[] } = {},
) {
  return new ApiError({ type: 'about:blank', title: 'Refused', status, ...rest });
}

interface Held {
  files?: MediaFile[];
  folders?: MediaFolder[];
  canManage?: boolean;
  canPublish?: boolean;
  quotaBytes?: number | null;
  nextCursor?: string | null;
}

/** Answers the lists from what the test holds, and anything else as the test says. */
function serve(
  held: Held,
  rest: (operation: string, input: unknown) => unknown = () => undefined,
): void {
  const canManage = held.canManage ?? true;
  server.answer = (operation, input) => {
    const custom = rest(operation, input);
    if (custom !== undefined) {
      if (custom instanceof Error) throw custom;
      return custom;
    }
    if (operation === 'listMedia')
      return {
        canManage,
        canPublish: held.canPublish ?? true,
        items: held.files ?? [],
        nextCursor: held.nextCursor ?? null,
      };
    if (operation === 'listMediaFolders') return { canManage, items: held.folders ?? [] };
    if (operation === 'getMediaUsage')
      return {
        files: (held.files ?? []).length,
        bytes: (held.files ?? []).reduce((sum, file) => sum + file.size, 0),
        businessBytes: 4_194_304,
        quotaBytes: held.quotaBytes ?? null,
        maxFileBytes: 1_048_576,
      };
    if (operation === 'getMediaFile') {
      const { id: fileId } = (input as { params: { id: string } }).params;
      const found = (held.files ?? []).find((file) => file.id === fileId);
      return { ...found, sha256: 'ab'.repeat(32), usedIn: [] };
    }
    return undefined;
  };
}

function wrap(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </I18nProvider>
  );
}

function show(): ReturnType<typeof userEvent.setup> {
  render(wrap(<MediaStoragePage />));
  return userEvent.setup();
}

const calls = (operation: string) =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);
const lastQuery = () =>
  (calls('listMedia').at(-1) as { query: Record<string, unknown> } | undefined)?.query;

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: HTMLElement,
  option: string,
): Promise<void> {
  await user.click(control);
  await user.click(await screen.findByRole('option', { name: option }));
}

async function menuOf(user: ReturnType<typeof userEvent.setup>, name: string, action: string) {
  await user.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}

/** The value, which the test expects to be there. */
function present<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) throw new Error('Expected a value.');
  return value;
}

const picture = (name: string, type = 'image/png', size = 2048) =>
  new File([new Uint8Array(size)], name, { type });

describe('the Media Storage page', () => {
  it('says so while it loads, then when the library is empty', async () => {
    serve({});
    show();

    expect(screen.getByRole('heading', { level: 1, name: 'Media Storage' })).toBeDefined();
    expect(screen.getByText('Loading files…')).toBeDefined();
    expect(await screen.findByText('No media files found')).toBeDefined();
    expect(
      screen.getByText('Upload files with the Upload button, or drop them anywhere on this page.'),
    ).toBeDefined();
    expect(screen.getByTestId('media-usage').textContent).toBe('0 files · 0 bytes');
    expect(lastQuery()).toEqual({ folder: 'root', sort: 'modified_desc', limit: 50 });
    expect(screen.getByText('Folders').getAttribute('aria-current')).toBe('page');
  });

  it('shows folders, then files as a grid of thumbnails with their size and date', async () => {
    serve({ files: [front, hero, tour, rows], folders: [brand, logos], quotaBytes: 5 * 1024 ** 3 });
    show();

    const grid = await screen.findByRole('list', { name: 'Files' });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(4);
    const card = within(grid).getByText('hero.png').closest('li') as HTMLElement;
    expect(within(card).getByText(/^2\.5 MB · /)).toBeDefined();
    expect(within(card).getByText('Public')).toBeDefined();
    expect(card.querySelector('img')?.getAttribute('src')).toBe(hero.previewUrl);
    expect(card.querySelector('img')?.getAttribute('loading')).toBe('lazy');
    // A video has no thumbnail in this version: its type's icon stands in.
    expect(
      (within(grid).getByText('tour.mp4').closest('li') as HTMLElement).querySelector('img'),
    ).toBeNull();

    // Only the folders at this level; the one inside Brand shows once Brand is opened.
    const folders = screen.getByRole('list', { name: 'Folders' });
    expect(within(folders).getAllByRole('listitem')).toHaveLength(1);
    expect(within(folders).getByText('2 files')).toBeDefined();
    expect(screen.getByTestId('media-usage').textContent).toBe(
      '4 files · 2.5 MB · 4 MB of 5 GB used by this business',
    );
  });

  it("falls back to the type's icon when a thumbnail does not load", async () => {
    serve({ files: [front] });
    show();

    const grid = await screen.findByRole('list', { name: 'Files' });
    const image = present(grid.querySelector('img'));
    fireEvent.error(image);

    expect(grid.querySelector('img')).toBeNull();
    expect(within(grid).getByText('front.png')).toBeDefined();
  });

  it('switches to a list, and back', async () => {
    serve({ files: [front, hero, tour, jingle, menu] });
    const user = show();
    await screen.findByRole('list', { name: 'Files' });
    expect(screen.getByRole('button', { name: 'Grid view' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'List view' }));

    const table = within(screen.getByRole('region', { name: 'Files' })).getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    const row = within(table).getByText('tour.mp4').closest('tr') as HTMLElement;
    expect(within(row).getByText('Video')).toBeDefined();
    expect(within(row).getByText('15 KB')).toBeDefined();
    expect(within(table).getByText('Audio')).toBeDefined();
    expect(within(table).getByText('Document')).toBeDefined();
    expect(within(table).getAllByText('Image')).toHaveLength(2);
    expect(within(table).getByText('Public')).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Files' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(screen.getByRole('list', { name: 'Files' })).toBeDefined();
  });

  it('opens a folder, shows the way back, and goes back', async () => {
    serve({ files: [front], folders: [brand, logos] });
    const user = show();

    await user.click(await screen.findByRole('button', { name: 'Open folder Brand' }));
    await waitFor(() => {
      expect(lastQuery()).toMatchObject({ folder: brand.id });
    });
    const path = screen.getByRole('navigation', { name: 'Folder path' });
    expect(within(path).getByText('Brand').getAttribute('aria-current')).toBe('page');
    await user.click(await screen.findByRole('button', { name: 'Open folder Logos' }));
    await waitFor(() => {
      expect(lastQuery()).toMatchObject({ folder: logos.id });
    });
    expect(within(path).getByText('Logos').getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('list', { name: 'Folders' })).toBeNull();

    await user.click(within(path).getByRole('button', { name: 'Brand' }));
    await waitFor(() => {
      expect(lastQuery()).toMatchObject({ folder: brand.id });
    });
    await user.click(within(path).getByRole('button', { name: 'Folders' }));
    await waitFor(() => {
      expect(lastQuery()).toMatchObject({ folder: 'root' });
    });
  });

  it('searches the whole library, filters by type and sorts, on the server', async () => {
    serve({ files: [front], folders: [brand] });
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Open folder Brand' }));

    await user.type(
      screen.getByRole('searchbox', { name: 'Search the entire media library' }),
      'logo',
    );
    await waitFor(() => {
      expect(lastQuery()).toEqual({ search: 'logo', sort: 'modified_desc', limit: 50 });
    });
    expect(screen.getByText('Results from the whole library')).toBeDefined();
    // Folders and the way to make one belong to browsing, not to a search.
    expect(screen.queryByRole('navigation', { name: 'Folder path' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();

    await choose(user, screen.getByRole('combobox', { name: 'Type of file' }), 'Videos');
    await waitFor(() => {
      expect(lastQuery()).toMatchObject({ search: 'logo', kind: 'video' });
    });
    await choose(user, screen.getByRole('combobox', { name: 'Sort by' }), 'Name: A to Z');
    await waitFor(() => {
      expect(lastQuery()).toMatchObject({ kind: 'video', sort: 'name_asc' });
    });
    await choose(user, screen.getByRole('combobox', { name: 'Type of file' }), 'All');
    await waitFor(() => {
      expect(lastQuery()).not.toHaveProperty('kind');
    });

    await user.clear(screen.getByRole('searchbox', { name: 'Search the entire media library' }));
    await waitFor(() => {
      expect(lastQuery()).toMatchObject({ folder: brand.id });
    });
  });

  it('says when nothing matches a search or a filter', async () => {
    serve({ files: [] });
    const user = show();
    await screen.findByText('No media files found');

    await choose(user, screen.getByRole('combobox', { name: 'Type of file' }), 'Audio');

    expect(await screen.findByText('Nothing matches. Try another search or filter.')).toBeDefined();
  });

  it('lists only public files when asked', async () => {
    serve({ files: [hero], folders: [brand] });
    const user = show();
    await screen.findByRole('list', { name: 'Files' });

    await choose(
      user,
      screen.getByRole('combobox', { name: 'Which files to show' }),
      'Public files',
    );

    await waitFor(() => {
      expect(lastQuery()).toEqual({ visibility: 'public', sort: 'modified_desc', limit: 50 });
    });
    expect(screen.queryByRole('list', { name: 'Folders' })).toBeNull();
    await choose(user, screen.getByRole('combobox', { name: 'Which files to show' }), 'My Media');
    await waitFor(() => {
      expect(lastQuery()).toMatchObject({ folder: 'root' });
    });
  });

  it('loads the next page when there is one', async () => {
    serve({ files: [front], nextCursor: 'after-front' }, (operation, input) => {
      const query = (input as { query?: { cursor?: string } }).query;
      return operation === 'listMedia' && query?.cursor === 'after-front'
        ? { canManage: true, canPublish: true, items: [hero], nextCursor: null }
        : undefined;
    });
    const user = show();

    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('hero.png')).toBeDefined();
    expect(screen.getByText('front.png')).toBeDefined();
    expect(lastQuery()).toMatchObject({ cursor: 'after-front' });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says when the files or the folders could not be loaded, and tries again', async () => {
    let fail = true;
    serve({ files: [front] }, (operation) =>
      fail && (operation === 'listMedia' || operation === 'listMediaFolders')
        ? refusal(403, { detail: 'No.' })
        : undefined,
    );
    const user = show();

    expect(await screen.findByText("We couldn't load the files.")).toBeDefined();
    expect(screen.getByText("We couldn't load the folders.")).toBeDefined();
    // Someone who can't read the library is offered nothing to change in it.
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();

    fail = false;
    for (const button of screen.getAllByRole('button', { name: 'Try again' }))
      await user.click(button);

    expect(await screen.findByText('front.png')).toBeDefined();
    expect(screen.queryByText("We couldn't load the folders.")).toBeNull();
  });
});

describe('folders', () => {
  it('makes a folder inside the one that is open', async () => {
    serve({ folders: [brand] });
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Open folder Brand' }));

    await user.click(screen.getByRole('button', { name: 'New folder' }));
    const dialog = await screen.findByRole('dialog', { name: 'New folder' });
    await user.click(within(dialog).getByRole('button', { name: 'Create folder' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Give the folder a name.');
    expect(calls('createMediaFolder')).toEqual([]);

    await user.type(within(dialog).getByLabelText('Folder name'), '  Logos ');
    await user.click(within(dialog).getByRole('button', { name: 'Create folder' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(calls('createMediaFolder')).toEqual([{ body: { name: 'Logos', parentId: brand.id } }]);
    expect(screen.getByRole('status').textContent).toBe('Folder created.');
  });

  it("shows the server's words when a name is taken, and keeps the dialog open", async () => {
    serve({ folders: [brand] }, (operation) =>
      operation === 'createMediaFolder'
        ? refusal(409, { detail: 'A folder with that name already exists there.' })
        : undefined,
    );
    const user = show();
    await screen.findByRole('button', { name: 'Open folder Brand' });

    await user.click(screen.getByRole('button', { name: 'New folder' }));
    const dialog = await screen.findByRole('dialog', { name: 'New folder' });
    await user.type(within(dialog).getByLabelText('Folder name'), 'brand');
    await user.click(within(dialog).getByRole('button', { name: 'Create folder' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'A folder with that name already exists there.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('refuses a folder name over 120 characters before asking the server', async () => {
    serve({});
    const user = show();
    await screen.findByText('No media files found');

    await user.click(screen.getByRole('button', { name: 'New folder' }));
    const dialog = await screen.findByRole('dialog', { name: 'New folder' });
    fireEvent.change(within(dialog).getByLabelText('Folder name'), {
      target: { value: 'a'.repeat(121) },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Create folder' }));

    expect(within(dialog).getByRole('alert').textContent).toBe('Use at most 120 characters.');
    expect(calls('createMediaFolder')).toEqual([]);
  });

  it('renames, moves and deletes a folder from its menu', async () => {
    const archive = folderOf('s', 'Archive');
    serve({ folders: [brand, logos, archive] });
    const user = show();
    await screen.findByRole('button', { name: 'Open folder Brand' });

    await menuOf(user, 'folder Brand', 'Rename');
    const rename = await screen.findByRole('dialog', { name: 'Rename folder' });
    const name = within(rename).getByLabelText('Folder name');
    expect((name as HTMLInputElement).value).toBe('Brand');
    await user.clear(name);
    await user.click(within(rename).getByRole('button', { name: 'Rename' }));
    expect(within(rename).getByRole('alert').textContent).toBe('Give the folder a name.');
    await user.type(name, 'Branding');
    await user.click(within(rename).getByRole('button', { name: 'Rename' }));
    await waitFor(() => {
      expect(calls('updateMediaFolder')).toEqual([
        { params: { id: brand.id }, body: { name: 'Branding' } },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await menuOf(user, 'folder Brand', 'Move');
    const move = await screen.findByRole('dialog', { name: 'Move folder "Brand"' });
    await user.click(within(move).getByRole('combobox', { name: 'Move to' }));
    // Not into itself, and not into the folder inside it.
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'My Media (top level)',
      'Archive',
    ]);
    await user.click(screen.getByRole('option', { name: 'Archive' }));
    await user.click(within(move).getByRole('button', { name: 'Move' }));
    await waitFor(() => {
      expect(calls('updateMediaFolder').at(-1)).toEqual({
        params: { id: brand.id },
        body: { parentId: archive.id },
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await menuOf(user, 'folder Brand', 'Delete');
    const confirm = await screen.findByRole('dialog', { name: 'Delete folder "Brand"?' });
    expect(
      within(confirm).getByText(/The files and folders inside it move to the folder above/),
    ).toBeDefined();
    await user.click(within(confirm).getByRole('button', { name: 'Delete folder' }));
    await waitFor(() => {
      expect(calls('removeMediaFolder')).toEqual([{ params: { id: brand.id } }]);
    });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        'Folder deleted. What it held is now in the folder above.',
      );
    });
  });
});

describe('a file', () => {
  it('is renamed, with the rules said before the server is asked', async () => {
    serve({ files: [front] });
    const user = show();
    await screen.findByText('front.png');

    await menuOf(user, 'front.png', 'Rename');
    const dialog = await screen.findByRole('dialog', { name: 'Rename file' });
    const name = within(dialog).getByLabelText('File name');
    expect((name as HTMLInputElement).value).toBe('front.png');
    await user.clear(name);
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Give the file a name.');
    expect(name.getAttribute('aria-invalid')).toBe('true');

    await user.type(name, 'Shop front.png');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(calls('updateMediaFile')).toEqual([
        { params: { id: front.id }, body: { name: 'Shop front.png' } },
      ]);
    });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('File renamed.');
    });
  });

  it('is moved to a folder, or back to the top', async () => {
    serve({ files: [{ ...front, folderId: brand.id }], folders: [brand, logos] });
    const user = show();
    await screen.findByText('front.png');

    await menuOf(user, 'front.png', 'Move');
    const dialog = await screen.findByRole('dialog', { name: 'Move "front.png"' });
    await user.click(within(dialog).getByRole('combobox', { name: 'Move to' }));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'My Media (top level)',
      'Brand',
      '– Logos',
    ]);
    await user.click(screen.getByRole('option', { name: '– Logos' }));
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));

    await waitFor(() => {
      expect(calls('moveMedia')).toEqual([{ body: { ids: [front.id], folderId: logos.id } }]);
    });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Moved.');
    });

    await menuOf(user, 'front.png', 'Move');
    const again = await screen.findByRole('dialog', { name: 'Move "front.png"' });
    await choose(
      user,
      within(again).getByRole('combobox', { name: 'Move to' }),
      'My Media (top level)',
    );
    await user.click(within(again).getByRole('button', { name: 'Move' }));
    await waitFor(() => {
      expect(calls('moveMedia').at(-1)).toEqual({ body: { ids: [front.id], folderId: null } });
    });
  });

  it('is deleted after a question, and the reason is shown when it is still used', async () => {
    let used = true;
    serve({ files: [front] }, (operation) =>
      operation === 'deleteMedia'
        ? used
          ? refusal(409, {
              detail: '"front.png" is still used by the business\'s logo. Remove it there first.',
            })
          : { count: 1 }
        : undefined,
    );
    const user = show();
    await screen.findByText('front.png');

    await menuOf(user, 'front.png', 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete "front.png"?' });
    expect(within(dialog).getByText(/This can't be undone/)).toBeDefined();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      '"front.png" is still used by the business\'s logo. Remove it there first.',
    );

    used = false;
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(calls('deleteMedia')).toEqual([
      { body: { ids: [front.id] } },
      { body: { ids: [front.id] } },
    ]);
    expect(screen.getByRole('status').textContent).toBe('Deleted.');
  });

  it('says the server was away when a gateway answers, and when the connection fails', async () => {
    let answer: unknown = refusal(503);
    serve({ files: [front] }, (operation) => (operation === 'deleteMedia' ? answer : undefined));
    const user = show();
    await screen.findByText('front.png');

    await menuOf(user, 'front.png', 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete "front.png"?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      "The server didn't answer just then, so nothing was changed. Wait a moment and try again.",
    );

    answer = new TypeError('Failed to fetch');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(within(dialog).getByRole('alert').textContent).toBe(
        "That didn't work. Check your connection and try again.",
      );
    });

    answer = refusal(422, {
      detail: 'Wrong.',
      errors: [{ path: '/ids', code: 'x', message: 'Name each file once.' }],
    });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(within(dialog).getByRole('alert').textContent).toBe('Name each file once.');
    });
  });

  it('is made public and private again from its menu', async () => {
    serve({ files: [front, hero] }, (operation, input) =>
      operation === 'updateMediaFile'
        ? {
            ...front,
            public: (input as { body: { public: boolean } }).body.public,
            publicUrl: null,
          }
        : undefined,
    );
    const user = show();
    await screen.findByText('front.png');

    await menuOf(user, 'front.png', 'Make public');
    await waitFor(() => {
      expect(calls('updateMediaFile')).toEqual([
        { params: { id: front.id }, body: { public: true } },
      ]);
    });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        '"front.png" is public now. Copy its link to use it in a page or an email.',
      );
    });

    await menuOf(user, 'hero.png', 'Make private');
    await waitFor(() => {
      expect(calls('updateMediaFile').at(-1)).toEqual({
        params: { id: hero.id },
        body: { public: false },
      });
    });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        '"front.png" is private again. Its public link has stopped working.',
      );
    });
  });

  it("says why when it can't be made public", async () => {
    serve({ files: [front] }, (operation) =>
      operation === 'updateMediaFile'
        ? refusal(422, {
            errors: [
              {
                path: '/public',
                code: 'public_media_unavailable',
                message: "This install doesn't serve public files yet.",
              },
            ],
          })
        : undefined,
    );
    const user = show();
    await screen.findByText('front.png');

    await menuOf(user, 'front.png', 'Make public');

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        "This install doesn't serve public files yet.",
      );
    });
  });

  it('offers no public address where the install serves none', async () => {
    serve({ files: [front], canPublish: false });
    const user = show();
    await screen.findByText('front.png');

    expect(screen.queryByRole('combobox', { name: 'Which files to show' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Actions for front.png' }));
    expect(await screen.findByRole('menuitem', { name: 'Copy link' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'Make public' })).toBeNull();
  });

  it('copies its public link, or a signed one that lasts seven days', async () => {
    const copied: string[] = [];
    serve({ files: [front, hero] }, (operation) =>
      operation === 'createFileLink'
        ? { url: 'https://crm.example.test/api/v1/files/x/content?signature=y', expiresAt: at }
        : undefined,
    );
    const user = show();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
    await screen.findByText('front.png');

    await menuOf(user, 'hero.png', 'Copy link');
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Public link copied.');
    });
    expect(copied).toEqual([hero.publicUrl]);
    expect(calls('createFileLink')).toEqual([]);

    await menuOf(user, 'front.png', 'Copy link');
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        'Link copied. It works for 7 days; make the file public for a link that lasts.',
      );
    });
    expect(copied.at(-1)).toBe('https://crm.example.test/api/v1/files/x/content?signature=y');
    expect(calls('createFileLink')).toEqual([
      { params: { id: front.id }, body: { expiresIn: 604_800 } },
    ]);
  });

  it("says when a link couldn't be copied or a download couldn't start", async () => {
    serve({ files: [front] }, (operation) =>
      operation === 'createFileLink' ? refusal(404, { detail: 'Gone.' }) : undefined,
    );
    const user = show();
    await screen.findByText('front.png');

    await menuOf(user, 'front.png', 'Copy link');
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        "The link couldn't be copied. Try again.",
      );
    });
    await menuOf(user, 'front.png', 'Download');
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        "The download couldn't be started. Try again.",
      );
    });
  });

  it('is downloaded by a short signed link, under its own name', async () => {
    const clicked: { href: string; download: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download });
    });
    serve({ files: [hero] }, (operation) =>
      operation === 'createFileLink'
        ? { url: 'https://crm.example.test/api/v1/files/x/content?signature=y', expiresAt: at }
        : undefined,
    );
    const user = show();
    await screen.findByText('hero.png');

    await menuOf(user, 'hero.png', 'Download');

    await waitFor(() => {
      expect(clicked).toEqual([
        {
          href: 'https://crm.example.test/api/v1/files/x/content?signature=y',
          download: 'hero.png',
        },
      ]);
    });
    // Even a public file downloads by a signed link: the public address shows it in place.
    expect(calls('createFileLink')).toEqual([
      { params: { id: hero.id }, body: { expiresIn: 300 } },
    ]);
    click.mockRestore();
  });
});

describe('several files at once', () => {
  it('moves and deletes what is selected', async () => {
    serve({ files: [front, hero, tour], folders: [brand] }, (operation) =>
      operation === 'moveMedia' || operation === 'deleteMedia' ? { count: 2 } : undefined,
    );
    const user = show();
    await screen.findByText('front.png');
    expect(screen.queryByRole('group', { name: 'Selected files' })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Select front.png' }));
    expect(
      within(screen.getByRole('group', { name: 'Selected files' })).getByText('1 selected'),
    ).toBeDefined();
    await user.click(screen.getByRole('checkbox', { name: 'Select tour.mp4' }));
    const bar = screen.getByRole('group', { name: 'Selected files' });
    expect(within(bar).getByText('2 selected')).toBeDefined();

    await user.click(within(bar).getByRole('button', { name: 'Move' }));
    const move = await screen.findByRole('dialog', { name: 'Move 2 files' });
    await choose(user, within(move).getByRole('combobox', { name: 'Move to' }), 'Brand');
    await user.click(within(move).getByRole('button', { name: 'Move' }));
    await waitFor(() => {
      expect(calls('moveMedia')).toEqual([
        { body: { ids: [front.id, tour.id], folderId: brand.id } },
      ]);
    });
    // What was selected is let go once it is done.
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Selected files' })).toBeNull();
    });

    await user.click(screen.getByRole('checkbox', { name: 'Select front.png' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select hero.png' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select hero.png' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select hero.png' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Selected files' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    const confirm = await screen.findByRole('dialog', { name: 'Delete 2 files?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(calls('deleteMedia')).toEqual([{ body: { ids: [front.id, hero.id] } }]);
    });
  });

  it('selects in the list view too, and clears the selection', async () => {
    serve({ files: [front, hero] });
    const user = show();
    await screen.findByText('front.png');
    await user.click(screen.getByRole('button', { name: 'List view' }));

    await user.click(screen.getByRole('checkbox', { name: 'Select hero.png' }));
    const bar = screen.getByRole('group', { name: 'Selected files' });
    expect(within(bar).getByText('1 selected')).toBeDefined();

    await user.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('group', { name: 'Selected files' })).toBeNull();
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Select hero.png' }).checked,
    ).toBe(false);
  });
});

describe('the preview', () => {
  async function preview(file: MediaFile, usedIn: string[] = []) {
    serve({ files: [file] }, (operation) =>
      operation === 'getMediaFile' ? { ...file, sha256: 'ab'.repeat(32), usedIn } : undefined,
    );
    const user = show();
    await user.click(await screen.findByRole('button', { name: `Preview ${file.name}` }));
    return { user, dialog: await screen.findByRole('dialog', { name: file.name }) };
  }

  it('shows a picture, what is known about it and where it is used', async () => {
    const { dialog } = await preview(hero, ['business_logo', 'calendar']);

    expect(within(dialog).getByRole('img', { name: 'hero.png' }).getAttribute('src')).toBe(
      hero.previewUrl,
    );
    expect(within(dialog).getByText('Image')).toBeDefined();
    expect(within(dialog).getByText('2.5 MB')).toBeDefined();
    expect(within(dialog).getByText('Public: anyone with the link can open it')).toBeDefined();
    expect(within(dialog).getByText(hero.publicUrl ?? '')).toBeDefined();
    expect(
      await within(dialog).findByText("The business's logo, A calendar's logo or cover"),
    ).toBeDefined();
  });

  it('plays a video and a sound in the browser', async () => {
    const video = await preview(tour);
    const player = present(video.dialog.querySelector('video'));
    expect(player.getAttribute('src')).toBe(tour.previewUrl);
    expect(player.hasAttribute('controls')).toBe(true);
    expect(within(video.dialog).getByText('Private')).toBeDefined();
    cleanup();

    const sound = await preview(jingle);
    expect(present(sound.dialog.querySelector('audio')).getAttribute('src')).toBe(
      jingle.previewUrl,
    );
  });

  it("opens a PDF in the browser's own viewer, and shows only the details of anything else", async () => {
    const pdf = await preview(menu);
    expect(within(pdf.dialog).getByTitle('menu.pdf').tagName).toBe('IFRAME');
    cleanup();

    const csv = await preview(rows);
    expect(csv.dialog.querySelector('iframe, img, video, audio')).toBeNull();
    expect(within(csv.dialog).getByText('Document')).toBeDefined();
    expect(within(csv.dialog).queryByText('Used in')).toBeNull();
  });

  it('copies the link and downloads from there, and closes', async () => {
    const copied: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const { user, dialog } = await preview(hero);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });

    await user.click(within(dialog).getByRole('button', { name: 'Copy link' }));
    await waitFor(() => {
      expect(copied).toEqual([hero.publicUrl]);
    });
    server.answer = ((before) => (operation: string, input: unknown) =>
      operation === 'createFileLink'
        ? { url: 'https://crm.example.test/api/v1/files/x/content?s=1', expiresAt: at }
        : before(operation, input))(server.answer);
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledTimes(1);
    });

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    click.mockRestore();
  });
});

describe('uploading', () => {
  const input = () => screen.getByLabelText('Choose files to upload');

  it('sends each file into the open folder and shows how far it is', async () => {
    serve({ folders: [brand] });
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Open folder Brand' }));
    expect(input().getAttribute('accept')).toContain('video/mp4');
    expect(input().hasAttribute('multiple')).toBe(true);

    await user.upload(input(), [picture('a.png'), picture('b.png'), picture('c.png')]);

    const list = await screen.findByRole('region', { name: 'Uploads' });
    expect(within(list).getByText('Uploading 3 files')).toBeDefined();
    // Two go up at once; the third waits its turn.
    await waitFor(() => {
      expect(sent.list).toHaveLength(2);
    });
    expect(sent.list[0]?.request).toMatchObject({
      businessId: 'biz_test',
      name: 'a.png',
      type: 'image/png',
      folderId: brand.id,
    });
    expect(within(list).getByText('Waiting')).toBeDefined();

    act(() => {
      sent.list[0]?.request.onProgress(1024);
    });
    const bar = within(list).getByRole('progressbar', { name: 'Upload of a.png' });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(within(list).getByText('50%')).toBeDefined();

    const before = calls('listMedia').length;
    act(() => {
      sent.list[0]?.end({ ok: true, fileId: front.id });
    });
    expect(await within(list).findByText('Uploaded')).toBeDefined();
    await waitFor(() => {
      expect(sent.list).toHaveLength(3);
    });
    // The list is read again, so the new file shows.
    await waitFor(() => {
      expect(calls('listMedia').length).toBeGreaterThan(before);
    });
    expect(within(list).getByText('Uploading 2 files')).toBeDefined();

    act(() => {
      sent.list[1]?.end({ ok: true, fileId: hero.id });
    });
    expect(await within(list).findByText('Uploading 1 file')).toBeDefined();
    act(() => {
      sent.list[2]?.end({ ok: true, fileId: tour.id });
    });
    await waitFor(() => {
      expect(within(list).getAllByText('Uploaded')).toHaveLength(3);
    });

    await user.click(within(list).getByRole('button', { name: 'Clear finished' }));
    expect(screen.queryByRole('region', { name: 'Uploads' })).toBeNull();
  });

  it('refuses a type the server does not store and a file over the limit, without sending them', async () => {
    serve({});
    const user = userEvent.setup({ applyAccept: false });
    render(wrap(<MediaStoragePage />));
    await screen.findByText('No media files found');

    await user.upload(input(), [
      picture('drawing.svg', 'image/svg+xml'),
      picture('huge.png', 'image/png', 1_048_577),
      picture('empty.txt', 'text/plain', 0),
    ]);

    const list = await screen.findByRole('region', { name: 'Uploads' });
    const alerts = within(list)
      .getAllByRole('alert')
      .map((alert) => alert.textContent);
    expect(alerts).toEqual([
      "This type of file can't be uploaded here. Use a PNG, JPEG, GIF or WebP image, an MP4 or WebM video, an MP3, WAV, Ogg or M4A sound, a PDF, or a text or CSV file.",
      'This file is too large. The limit is 1 MB.',
      'This file is empty, so there is nothing to upload.',
    ]);
    expect(sent.list).toEqual([]);
    expect(within(list).queryByRole('button', { name: /Try uploading/ })).toBeNull();
    expect(within(list).getByText('Uploads')).toBeDefined();
  });

  it('says in plain words why the server did not take a file, and tries again', async () => {
    serve({});
    const user = show();
    await screen.findByText('No media files found');

    await user.upload(input(), [picture('a.png'), picture('b.png')]);
    await waitFor(() => {
      expect(sent.list).toHaveLength(2);
    });
    act(() => {
      sent.list[0]?.end({ ok: false, failure: 'no_answer' });
      sent.list[1]?.end({
        ok: false,
        failure: 'refused',
        detail:
          "This business's storage is full: it holds 5 of 5 bytes. Delete files to make room.",
      });
    });

    const list = screen.getByRole('region', { name: 'Uploads' });
    await waitFor(() => {
      expect(
        within(list)
          .getAllByRole('alert')
          .map((alert) => alert.textContent),
      ).toEqual([
        "The server didn't answer just then, so this file wasn't uploaded. Wait a moment and try again.",
        "This business's storage is full: it holds 5 of 5 bytes. Delete files to make room.",
      ]);
    });

    await user.click(within(list).getByRole('button', { name: 'Try uploading a.png again' }));
    await waitFor(() => {
      expect(sent.list).toHaveLength(3);
    });
    expect(sent.list[2]?.request.name).toBe('a.png');
    act(() => {
      sent.list[2]?.end({ ok: false, failure: 'connection' });
    });
    await waitFor(() => {
      expect(within(list).getAllByRole('alert')[0]?.textContent).toBe(
        "The upload didn't get through. Check your connection and try again.",
      );
    });
    act(() => {
      sent.list[2]?.end({ ok: false, failure: 'type' });
    });
  });

  it("uses the server's own word for too large, and its own for a refusal it does not explain", async () => {
    serve({});
    const user = show();
    await screen.findByText('No media files found');

    await user.upload(input(), [picture('a.png'), picture('b.png')]);
    await waitFor(() => {
      expect(sent.list).toHaveLength(2);
    });
    act(() => {
      sent.list[0]?.end({ ok: false, failure: 'too_large' });
      sent.list[1]?.end({ ok: false, failure: 'refused' });
    });

    const list = screen.getByRole('region', { name: 'Uploads' });
    await waitFor(() => {
      expect(
        within(list)
          .getAllByRole('alert')
          .map((alert) => alert.textContent),
      ).toEqual([
        'This file is too large. The limit is 1 MB.',
        "The server didn't take this file.",
      ]);
    });
  });

  it('cancels an upload that is going, and can start it again', async () => {
    serve({});
    const user = show();
    await screen.findByText('No media files found');

    await user.upload(input(), [picture('a.png')]);
    await waitFor(() => {
      expect(sent.list).toHaveLength(1);
    });
    const list = screen.getByRole('region', { name: 'Uploads' });
    await user.click(within(list).getByRole('button', { name: 'Cancel upload of a.png' }));

    expect(sent.list[0]?.cancelled).toBe(true);
    expect(await within(list).findByText('Cancelled')).toBeDefined();
    expect(within(list).queryByRole('alert')).toBeNull();
    expect(within(list).queryByRole('progressbar')).toBeNull();

    await user.click(within(list).getByRole('button', { name: 'Try uploading a.png again' }));
    await waitFor(() => {
      expect(sent.list).toHaveLength(2);
    });
  });

  it('takes files dropped anywhere on the page, and says where they will go', async () => {
    serve({ folders: [brand] });
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Open folder Brand' }));
    const page = present(screen.getByTestId('media-usage').parentElement);
    const dataTransfer = { types: ['Files'], files: [picture('dropped.png')], dropEffect: 'none' };

    fireEvent.dragEnter(page, { dataTransfer });
    expect(screen.getByText('Drop files to upload them to Brand')).toBeDefined();
    fireEvent.dragOver(page, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe('copy');
    fireEvent.dragLeave(page, { dataTransfer, relatedTarget: null });
    expect(screen.queryByText('Drop files to upload them to Brand')).toBeNull();

    fireEvent.dragEnter(page, { dataTransfer });
    // Moving onto something inside the page is still over the page.
    // jsdom has no DragEvent, so where the pointer went is set on the event by hand.
    const inward = createEvent.dragLeave(page, { dataTransfer });
    Object.defineProperty(inward, 'relatedTarget', { value: screen.getByTestId('media-usage') });
    fireEvent(page, inward);
    expect(screen.getByText('Drop files to upload them to Brand')).toBeDefined();
    fireEvent.drop(page, { dataTransfer });

    expect(screen.queryByText('Drop files to upload them to Brand')).toBeNull();
    await waitFor(() => {
      expect(sent.list).toHaveLength(1);
    });
    expect(sent.list[0]?.request).toMatchObject({ name: 'dropped.png', folderId: brand.id });
  });

  it('ignores what is dragged over that is not a file', async () => {
    serve({});
    show();
    await screen.findByText('No media files found');
    const page = present(screen.getByTestId('media-usage').parentElement);
    const dataTransfer = { types: ['text/plain'], files: [], dropEffect: 'none' };

    fireEvent.dragEnter(page, { dataTransfer });
    fireEvent.dragOver(page, { dataTransfer });
    fireEvent.drop(page, { dataTransfer });

    expect(screen.queryByText(/Drop files to upload/)).toBeNull();
    expect(dataTransfer.dropEffect).toBe('none');
    expect(sent.list).toEqual([]);
  });

  it('puts an upload made during a search at the top of the library', async () => {
    serve({ folders: [brand] });
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Open folder Brand' }));
    await user.type(
      screen.getByRole('searchbox', { name: 'Search the entire media library' }),
      'x',
    );
    await screen.findByText('Results from the whole library');

    await user.upload(input(), [picture('a.png')]);

    await waitFor(() => {
      expect(sent.list).toHaveLength(1);
    });
    expect(sent.list[0]?.request.folderId).toBeNull();
  });
});

describe('someone who may only read the library', () => {
  it('sees, previews, copies and downloads, and is offered nothing that changes it', async () => {
    serve({ files: [front], folders: [brand], canManage: false });
    const user = show();
    await screen.findByText('front.png');

    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for folder Brand' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Actions for front.png' }));
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'Preview',
      'Copy link',
      'Download',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Preview' }));
    expect(await screen.findByRole('dialog', { name: 'front.png' })).toBeDefined();
  });

  it('is told an empty library fills from the team, and that dropping does nothing', async () => {
    serve({ canManage: false });
    show();

    expect(
      await screen.findByText('Files your team uploads here will show in this list.'),
    ).toBeDefined();
    const page = present(screen.getByTestId('media-usage').parentElement);
    fireEvent.dragEnter(page, { dataTransfer: { types: ['Files'], files: [picture('a.png')] } });
    expect(screen.queryByText(/Drop files to upload/)).toBeNull();
  });
});

describe('the media picker', () => {
  function pick(kinds?: readonly MediaKind[]) {
    const chosen: MediaFile[] = [];
    let closed = 0;
    render(
      wrap(
        <MediaPicker
          businessId="biz_test"
          title="Choose a logo"
          {...(kinds === undefined ? {} : { kinds })}
          onChoose={(file) => {
            chosen.push(file);
          }}
          onClose={() => {
            closed += 1;
          }}
        />,
      ),
    );
    return { user: userEvent.setup(), chosen, closed: () => closed };
  }

  it('lists the pictures of the library and hands back the one pressed', async () => {
    serve({ files: [front, hero], folders: [brand] });
    const { user, chosen } = pick(['image']);

    const dialog = await screen.findByRole('dialog', { name: 'Choose a logo' });
    expect(
      within(dialog).getByText('Choose a file from Media Storage, or upload one into it.'),
    ).toBeDefined();
    await within(dialog).findByText('front.png');
    expect(lastQuery()).toEqual({
      folder: 'root',
      kind: 'image',
      sort: 'modified_desc',
      limit: 50,
    });
    // One group of types only: there is nothing to filter by.
    expect(within(dialog).queryByRole('combobox', { name: 'Type of file' })).toBeNull();
    // Choosing is all a picker does to a file.
    expect(within(dialog).queryByRole('button', { name: 'Actions for front.png' })).toBeNull();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Actions for folder Brand' })).toBeNull();
    expect(within(dialog).getByLabelText('Choose files to upload').getAttribute('accept')).toBe(
      'image/png,image/jpeg,image/gif,image/webp',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Choose hero.png' }));

    expect(chosen).toEqual([hero]);
  });

  it('chooses from the list view too, and from inside a folder', async () => {
    serve({ files: [front], folders: [brand] });
    const { user, chosen } = pick(['image']);
    const dialog = await screen.findByRole('dialog', { name: 'Choose a logo' });
    await within(dialog).findByText('front.png');

    await user.click(within(dialog).getByRole('button', { name: 'Open folder Brand' }));
    await waitFor(() => {
      expect(lastQuery()).toMatchObject({ folder: brand.id, kind: 'image' });
    });
    await user.click(within(dialog).getByRole('button', { name: 'List view' }));
    await user.click(within(dialog).getByRole('button', { name: 'Choose front.png' }));

    expect(chosen).toEqual([front]);
  });

  it('uploads into the library, refusing what its caller does not take', async () => {
    serve({});
    const chosen: MediaFile[] = [];
    render(
      wrap(
        <MediaPicker
          businessId="biz_test"
          title="Choose a logo"
          kinds={['image']}
          onChoose={(file) => chosen.push(file)}
          onClose={() => undefined}
        />,
      ),
    );
    const user = userEvent.setup({ applyAccept: false });
    const dialog = await screen.findByRole('dialog', { name: 'Choose a logo' });
    await within(dialog).findByText('No media files found');

    await user.upload(within(dialog).getByLabelText('Choose files to upload'), [
      picture('menu.pdf', 'application/pdf'),
      picture('logo.png'),
    ]);

    await waitFor(() => {
      expect(sent.list).toHaveLength(1);
    });
    expect(sent.list[0]?.request.name).toBe('logo.png');
    expect(within(dialog).getByRole('alert').textContent).toMatch(
      /^This type of file can't be uploaded here/,
    );
  });

  it('offers every type when its caller takes any, and closes', async () => {
    serve({ files: [front, menu] });
    const { user, closed } = pick();
    const dialog = await screen.findByRole('dialog', { name: 'Choose a logo' });
    await within(dialog).findByText('menu.pdf');

    expect(lastQuery()).toEqual({ folder: 'root', sort: 'modified_desc', limit: 50 });
    expect(within(dialog).getByRole('combobox', { name: 'Type of file' })).toBeDefined();

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(closed()).toBe(1);
  });

  it('narrows the type filter to the groups its caller takes', async () => {
    serve({ files: [front] });
    const { user } = pick(['image', 'video']);
    const dialog = await screen.findByRole('dialog', { name: 'Choose a logo' });
    await within(dialog).findByText('front.png');

    await user.click(within(dialog).getByRole('combobox', { name: 'Type of file' }));

    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'All',
      'Images',
      'Videos',
    ]);
  });
});
