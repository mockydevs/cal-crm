import type { MediaFolder } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { listQuery, type MediaListFilter } from './data';
import {
  acceptOf,
  canRetry,
  childrenOf,
  failureOf,
  folderOptions,
  insideOf,
  nameProblem,
  nextUploads,
  percentOf,
  refusalOf,
  sizeOf,
  splitName,
  trailOf,
  uploadQueue,
  uploadType,
  type UploadEvent,
  type UploadItem,
} from './rules';

const at = '2026-10-12T09:00:00.000Z';
const folder = (id: string, name: string, parentId: string | null = null): MediaFolder => ({
  id,
  parentId,
  name,
  fileCount: 0,
  createdAt: at,
  updatedAt: at,
});
const brand = folder('mfld_brand', 'Brand');
const logos = folder('mfld_logos', 'logos', 'mfld_brand');
const marks = folder('mfld_marks', 'Marks', 'mfld_logos');
const archive = folder('mfld_archive', 'archive');
const tree = [marks, archive, logos, brand];

/** The value, which the test expects to be there. */
function present<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) throw new Error('Expected a value.');
  return value;
}

describe('the type a file is sent as', () => {
  it.each([
    ['photo.png', 'image/png', 'image/png'],
    ['photo.JPG', 'image/jpg', 'image/jpeg'],
    ['clip.mp4', 'video/mp4', 'video/mp4'],
    ['song.mp3', 'audio/mp3', 'audio/mpeg'],
    ['voice.wav', 'audio/x-wav', 'audio/wav'],
    ['voice.wav', 'audio/wave', 'audio/wav'],
    ['memo.m4a', 'audio/x-m4a', 'audio/mp4'],
    ['rows.csv', 'application/csv', 'text/csv'],
    ['rows.csv', 'application/vnd.ms-excel', 'text/csv'],
    ['notes.txt', 'text/plain; charset=utf-8', 'text/plain'],
    ['PHOTO.PNG', 'IMAGE/PNG', 'image/png'],
  ])('%s sent by the browser as %s is %s', (name, type, expected) => {
    expect(uploadType({ name, type })).toBe(expected);
  });

  it.each([
    ['scan.pdf', 'application/pdf'],
    ['clip.webm', 'video/webm'],
    ['tune.ogg', 'audio/ogg'],
    ['tune.oga', 'audio/ogg'],
    ['photo.jpeg', 'image/jpeg'],
    ['anim.gif', 'image/gif'],
    ['pic.webp', 'image/webp'],
    ['Report.TXT', 'text/plain'],
  ])('%s with no type from the browser is %s, by its name', (name, expected) => {
    expect(uploadType({ name, type: '' })).toBe(expected);
    expect(uploadType({ name, type: 'application/octet-stream' })).toBe(expected);
  });

  it.each([
    ['drawing.svg', 'image/svg+xml'],
    ['page.html', 'text/html'],
    ['letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['sheet.xls', 'application/vnd.ms-excel'],
    ['archive.zip', 'application/zip'],
    ['README', ''],
    ['.env', ''],
    ['movie.mov', 'video/quicktime'],
    // A name alone does not make a known type of something the browser called otherwise.
    ['renamed.png', 'text/html'],
  ])('%s (%s) is none the server stores', (name, type) => {
    expect(uploadType({ name, type })).toBeUndefined();
  });
});

describe('what a file input offers', () => {
  it('is every stored type, or one group of them', () => {
    expect(acceptOf().split(',')).toHaveLength(13);
    expect(acceptOf(['image'])).toBe('image/png,image/jpeg,image/gif,image/webp');
    expect(acceptOf(['video', 'audio'])).toBe(
      'video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,audio/mp4',
    );
    expect(acceptOf(['document'])).toBe('application/pdf,text/plain,text/csv');
  });
});

describe('a file the page refuses itself', () => {
  const limits = { maxFileBytes: 1000 };

  it('takes a file of a stored type within the limit', () => {
    expect(refusalOf({ name: 'a.png', type: 'image/png', size: 1000 }, limits)).toBeUndefined();
  });

  it.each([
    [
      'a type the server does not store',
      { name: 'a.svg', type: 'image/svg+xml', size: 10 },
      'type',
    ],
    ['a file over the limit', { name: 'a.png', type: 'image/png', size: 1001 }, 'too_large'],
    ['an empty file', { name: 'a.txt', type: 'text/plain', size: 0 }, 'empty'],
    // The type is said first: a larger limit would not help.
    [
      'a large file of a wrong type',
      { name: 'a.zip', type: 'application/zip', size: 5000 },
      'type',
    ],
  ] as const)('refuses %s', (_case, file, refusal) => {
    expect(refusalOf(file, limits)).toBe(refusal);
  });

  it('holds a picker to its groups of types', () => {
    const pdf = { name: 'a.pdf', type: 'application/pdf', size: 10 };
    expect(refusalOf(pdf, { ...limits, kinds: ['image'] })).toBe('type');
    expect(refusalOf(pdf, { ...limits, kinds: ['document', 'image'] })).toBeUndefined();
  });

  it('leaves the size to the server until the limit is known', () => {
    expect(
      refusalOf({ name: 'a.png', type: 'image/png', size: 10 ** 12 }, { maxFileBytes: undefined }),
    ).toBeUndefined();
  });
});

describe('a size', () => {
  it.each([
    [0, '0', 'B'],
    [1023, '1023', 'B'],
    [1024, '1', 'KB'],
    [1536, '1.5', 'KB'],
    [10 * 1024, '10', 'KB'],
    [15_800, '15', 'KB'],
    [1_048_576, '1', 'MB'],
    [26_214_400, '25', 'MB'],
    [3_565_158, '3.4', 'MB'],
    [5 * 1024 ** 3, '5', 'GB'],
    [2000 * 1024 ** 3, '2000', 'GB'],
  ])('%d bytes is %s %s', (bytes, value, unit) => {
    expect(sizeOf(bytes)).toEqual({ value, unit });
  });
});

describe('a name', () => {
  it('is fine when the server would take it', () => {
    expect(nameProblem('Shop front.png')).toBeUndefined();
    expect(nameProblem('  padded.png  ')).toBeUndefined();
  });

  it.each([
    ['', 'Give the file a name.'],
    ['   ', 'Give the file a name.'],
    ['a'.repeat(256), 'Use at most 255 characters.'],
    ['a\nb.png', "A file name can't hold control characters."],
    ['invoice‮gnp.exe', "A file name can't hold control characters."],
  ])('says what is wrong with %j', (name, problem) => {
    expect(nameProblem(name)).toBe(problem);
  });

  it.each([
    ['photo.png', 'photo', '.png'],
    ['archive.tar.gz', 'archive.tar', '.gz'],
    ['README', 'README', ''],
    ['.env', '.env', ''],
    ['trailing.', 'trailing', '.'],
  ])('splits %s into %s and %s', (name, stem, extension) => {
    expect(splitName(name)).toEqual({ stem, extension });
  });
});

describe('the folder tree', () => {
  it('has no trail at the top, and the whole way down to a folder', () => {
    expect(trailOf(tree, null)).toEqual([]);
    expect(trailOf(tree, 'mfld_brand')).toEqual([brand]);
    expect(trailOf(tree, 'mfld_marks')).toEqual([brand, logos, marks]);
  });

  it('has no trail to a folder that is not there', () => {
    expect(trailOf(tree, 'mfld_gone')).toEqual([]);
  });

  it('stops at a folder whose parent is missing, and never loops', () => {
    const orphan = folder('mfld_orphan', 'Orphan', 'mfld_gone');
    expect(trailOf([orphan], 'mfld_orphan')).toEqual([orphan]);
    const a = folder('mfld_a', 'A', 'mfld_b');
    const b = folder('mfld_b', 'B', 'mfld_a');
    expect(trailOf([a, b], 'mfld_a')).toEqual([b, a]);
  });

  it('lists what is directly inside, by name without regard to case', () => {
    expect(childrenOf(tree, null)).toEqual([archive, brand]);
    expect(childrenOf(tree, 'mfld_brand')).toEqual([logos]);
    expect(childrenOf(tree, 'mfld_marks')).toEqual([]);
  });

  it('knows a folder and everything inside it', () => {
    expect([...insideOf(tree, 'mfld_brand')].sort()).toEqual([
      'mfld_brand',
      'mfld_logos',
      'mfld_marks',
    ]);
    expect([...insideOf(tree, 'mfld_archive')]).toEqual(['mfld_archive']);
  });

  it('reads as a tree for a list of places to move to', () => {
    expect(folderOptions(tree)).toEqual([
      { id: 'mfld_archive', name: 'archive', depth: 0 },
      { id: 'mfld_brand', name: 'Brand', depth: 0 },
      { id: 'mfld_logos', name: 'logos', depth: 1 },
      { id: 'mfld_marks', name: 'Marks', depth: 2 },
    ]);
    expect(folderOptions([])).toEqual([]);
  });
});

describe('the upload queue', () => {
  const file = (id: number, size = 100) => ({
    id,
    name: `f${String(id)}.png`,
    size,
    folderId: null,
  });
  const run = (events: readonly UploadEvent[], from: readonly UploadItem[] = []): UploadItem[] =>
    events.reduce<UploadItem[]>((queue, event) => uploadQueue(queue, event), [...from]);
  const states = (queue: readonly UploadItem[]) => queue.map((item) => item.state);

  it('takes files in the order they were chosen, waiting', () => {
    const queue = run([
      { type: 'add', items: [file(1), file(2)] },
      { type: 'add', items: [file(3)] },
    ]);
    expect(queue.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(states(queue)).toEqual(['waiting', 'waiting', 'waiting']);
    expect(queue.every((item) => item.sent === 0)).toBe(true);
  });

  it('starts at most the given number at once, oldest first', () => {
    const queue = run([{ type: 'add', items: [file(1), file(2), file(3)] }]);
    expect(nextUploads(queue, 2).map((item) => item.id)).toEqual([1, 2]);
    const started = run(
      [
        { type: 'start', id: 1 },
        { type: 'start', id: 2 },
      ],
      queue,
    );
    expect(nextUploads(started, 2)).toEqual([]);
    const oneDone = run([{ type: 'done', id: 1 }], started);
    expect(nextUploads(oneDone, 2).map((item) => item.id)).toEqual([3]);
    expect(nextUploads(oneDone, 0)).toEqual([]);
  });

  it('follows an upload from start to done', () => {
    const queue = run([
      { type: 'add', items: [file(1, 200)] },
      { type: 'start', id: 1 },
      { type: 'progress', id: 1, sent: 50 },
    ]);
    expect(queue[0]).toMatchObject({ state: 'uploading', sent: 50 });
    expect(percentOf(present(queue[0]))).toBe(25);
    const done = run([{ type: 'done', id: 1 }], queue);
    expect(done[0]).toMatchObject({ state: 'done', sent: 200 });
    expect(percentOf(present(done[0]))).toBe(100);
  });

  it('never shows progress going back, or past the end', () => {
    const queue = run([
      { type: 'add', items: [file(1, 100)] },
      { type: 'start', id: 1 },
      { type: 'progress', id: 1, sent: 80 },
      { type: 'progress', id: 1, sent: 40 },
    ]);
    expect(queue[0]?.sent).toBe(80);
    // A request's body is a little longer than the file: its headers count too.
    expect(run([{ type: 'progress', id: 1, sent: 130 }], queue)[0]?.sent).toBe(100);
    expect(percentOf({ ...file(2, 0), state: 'uploading', sent: 0 })).toBe(0);
    expect(percentOf({ ...file(3, 3), state: 'uploading', sent: 2 })).toBe(66);
  });

  it("keeps why an upload failed, and the server's own words", () => {
    const queue = run([
      { type: 'add', items: [file(1), file(2)] },
      { type: 'start', id: 1 },
      { type: 'fail', id: 1, failure: 'refused', detail: 'Storage is full.' },
      { type: 'fail', id: 2, failure: 'connection' },
    ]);
    expect(queue[0]).toMatchObject({
      state: 'failed',
      failure: 'refused',
      detail: 'Storage is full.',
    });
    expect(queue[1]).toMatchObject({ state: 'failed', failure: 'connection' });
    expect(queue[1]).not.toHaveProperty('detail');
  });

  it('lists a file the page refused, without ever sending it', () => {
    const queue = run([{ type: 'refuse', item: file(1), failure: 'too_large' }]);
    expect(queue[0]).toMatchObject({ state: 'failed', failure: 'too_large', sent: 0 });
    expect(nextUploads(queue, 2)).toEqual([]);
    expect(canRetry(present(queue[0]))).toBe(false);
    expect(run([{ type: 'retry', id: 1 }], queue)).toEqual(queue);
  });

  it('cancels a waiting or running upload, and nothing that is over', () => {
    const queue = run([
      { type: 'add', items: [file(1), file(2), file(3)] },
      { type: 'start', id: 1 },
      { type: 'start', id: 3 },
      { type: 'done', id: 3 },
      { type: 'cancel', id: 1 },
      { type: 'cancel', id: 2 },
      { type: 'cancel', id: 3 },
    ]);
    expect(states(queue)).toEqual(['cancelled', 'cancelled', 'done']);
  });

  it('ignores what arrives late for an upload that is over', () => {
    const queue = run([
      { type: 'add', items: [file(1)] },
      { type: 'start', id: 1 },
      { type: 'cancel', id: 1 },
    ]);
    const late = run(
      [
        { type: 'progress', id: 1, sent: 90 },
        { type: 'done', id: 1 },
        { type: 'fail', id: 1, failure: 'connection' },
        { type: 'start', id: 1 },
        { type: 'progress', id: 99, sent: 1 },
      ],
      queue,
    );
    expect(late).toEqual(queue);
  });

  it('tries again what could go differently, from the start', () => {
    const queue = run([
      { type: 'add', items: [file(1), file(2), file(3), file(4)] },
      { type: 'start', id: 1 },
      { type: 'progress', id: 1, sent: 60 },
      { type: 'fail', id: 1, failure: 'no_answer' },
      { type: 'start', id: 2 },
      { type: 'cancel', id: 2 },
      { type: 'start', id: 3 },
      { type: 'fail', id: 3, failure: 'type' },
      { type: 'start', id: 4 },
      { type: 'done', id: 4 },
    ]);
    expect(queue.map(canRetry)).toEqual([true, true, false, false]);

    const again = run(
      [
        { type: 'retry', id: 1 },
        { type: 'retry', id: 2 },
        { type: 'retry', id: 3 },
        { type: 'retry', id: 4 },
      ],
      queue,
    );
    expect(states(again)).toEqual(['waiting', 'waiting', 'failed', 'done']);
    expect(again[0]).toEqual({ ...file(1), state: 'waiting', sent: 0 });
    expect(nextUploads(again, 2).map((item) => item.id)).toEqual([1, 2]);
  });

  it('forgets what is over, and keeps what is still going', () => {
    const queue = run([
      { type: 'add', items: [file(1), file(2), file(3), file(4)] },
      { type: 'start', id: 1 },
      { type: 'start', id: 2 },
      { type: 'done', id: 2 },
      { type: 'fail', id: 3, failure: 'connection' },
      { type: 'clear' },
    ]);
    expect(queue.map((item) => [item.id, item.state])).toEqual([
      [1, 'uploading'],
      [4, 'waiting'],
    ]);
  });
});

describe("why the server didn't take an upload", () => {
  it.each([
    [0, undefined, { failure: 'connection' }],
    [502, undefined, { failure: 'no_answer' }],
    [503, '<html>Bad gateway</html>', { failure: 'no_answer' }],
    [504, undefined, { failure: 'no_answer' }],
    [413, { detail: 'Send at most 100 bytes.' }, { failure: 'too_large' }],
    [422, { errors: [{ code: 'unsupported_type' }] }, { failure: 'type' }],
    [422, { errors: [{ code: 'type_mismatch' }] }, { failure: 'type' }],
    [
      422,
      { detail: "This business's storage is full.", errors: [{ code: 'storage_full' }] },
      { failure: 'refused', detail: "This business's storage is full." },
    ],
    [
      403,
      { detail: "Your role can't add files to the media library." },
      { failure: 'refused', detail: "Your role can't add files to the media library." },
    ],
    [500, undefined, { failure: 'refused' }],
    [500, { errors: 'nonsense', detail: 7 }, { failure: 'refused' }],
    [422, { errors: [] }, { failure: 'refused' }],
  ])('%d %j', (status, body, expected) => {
    expect(failureOf(status, body)).toEqual(expected);
  });
});

describe('what a list asks the server for', () => {
  const filter: MediaListFilter = {
    folderId: null,
    search: '',
    kind: undefined,
    publicOnly: false,
    sort: 'modified_desc',
  };

  it('reads the top of the library, or a folder', () => {
    expect(listQuery(filter, undefined)).toEqual({
      folder: 'root',
      sort: 'modified_desc',
      limit: 50,
    });
    expect(listQuery({ ...filter, folderId: 'mfld_brand' }, 'next')).toEqual({
      folder: 'mfld_brand',
      sort: 'modified_desc',
      limit: 50,
      cursor: 'next',
    });
  });

  it('searches the whole library, whatever folder is open', () => {
    expect(
      listQuery(
        { ...filter, folderId: 'mfld_brand', search: '  logo ', kind: 'image', sort: 'name_asc' },
        undefined,
      ),
    ).toEqual({ search: 'logo', kind: 'image', sort: 'name_asc', limit: 50 });
    expect(listQuery({ ...filter, search: '   ' }, undefined)).toHaveProperty('folder', 'root');
  });

  it('lists public files from every folder', () => {
    expect(listQuery({ ...filter, folderId: 'mfld_brand', publicOnly: true }, undefined)).toEqual({
      visibility: 'public',
      sort: 'modified_desc',
      limit: 50,
    });
    expect(listQuery({ ...filter, folderId: undefined }, undefined)).toEqual({
      sort: 'modified_desc',
      limit: 50,
    });
  });
});
