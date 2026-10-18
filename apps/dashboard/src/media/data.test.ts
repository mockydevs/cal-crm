import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mediaKeys, sendUpload } from './data';

type Listener = (event: { loaded: number }) => void;

/** As much of XMLHttpRequest as an upload uses, driven by the test. */
class FakeRequest {
  static last: FakeRequest;
  readonly headers: Record<string, string> = {};
  readonly listeners: Record<string, Listener> = {};
  readonly upload = {
    addEventListener: (name: string, listener: Listener) => {
      this.listeners[`upload.${name}`] = listener;
    },
  };
  method = '';
  url = '';
  body: unknown;
  status = 0;
  responseText = '';
  aborted = false;

  constructor() {
    FakeRequest.last = this;
  }
  addEventListener(name: string, listener: Listener): void {
    this.listeners[name] = listener;
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: unknown): void {
    this.body = body;
  }
  abort(): void {
    this.aborted = true;
    this.listeners['abort']?.({ loaded: 0 });
  }
  answer(status: number, responseText: string): void {
    this.status = status;
    this.responseText = responseText;
    this.listeners['load']?.({ loaded: 0 });
  }
}

beforeEach(() => {
  vi.stubGlobal('XMLHttpRequest', FakeRequest);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const file = new Blob(['12345678']);
const start = (
  folderId: string | null = null,
  onProgress: (sent: number) => void = () => undefined,
) =>
  sendUpload({
    businessId: 'biz_test',
    file,
    name: 'shop front & more.png',
    type: 'image/png',
    folderId,
    onProgress,
  });

describe('an upload', () => {
  it("goes to the files API, into the library, as the business's own", async () => {
    const upload = start('mfld_brand');
    const request = FakeRequest.last;

    expect(request.method).toBe('POST');
    expect(request.url).toBe(
      '/api/v1/files?filename=shop+front+%26+more.png&library=true&folder=mfld_brand',
    );
    expect(request.headers).toEqual({
      accept: 'application/json, application/problem+json',
      'content-type': 'image/png',
      'business-id': 'biz_test',
    });
    expect(request.body).toBe(file);

    request.answer(201, JSON.stringify({ id: 'file_new', filename: 'shop front & more.png' }));
    expect(await upload.done).toEqual({ ok: true, fileId: 'file_new' });
  });

  it('names no folder for the top of the library', () => {
    start(null);
    expect(FakeRequest.last.url).toBe(
      '/api/v1/files?filename=shop+front+%26+more.png&library=true',
    );
  });

  it('says how many bytes have gone', () => {
    const seen: number[] = [];
    start(null, (sent) => seen.push(sent));

    FakeRequest.last.listeners['upload.progress']?.({ loaded: 3 });
    FakeRequest.last.listeners['upload.progress']?.({ loaded: 8 });

    expect(seen).toEqual([3, 8]);
  });

  it.each([
    [413, JSON.stringify({ detail: 'Send at most 10 bytes.' }), { failure: 'too_large' }],
    [422, JSON.stringify({ errors: [{ code: 'type_mismatch' }] }), { failure: 'type' }],
    [403, JSON.stringify({ detail: 'Not you.' }), { failure: 'refused', detail: 'Not you.' }],
    [502, '<html><h1>Bad Gateway</h1></html>', { failure: 'no_answer' }],
    [504, '', { failure: 'no_answer' }],
    // A success that is not the file the contract promises is not one.
    [201, 'null', { failure: 'refused' }],
    [201, JSON.stringify({ filename: 'a.png' }), { failure: 'refused' }],
    [200, JSON.stringify({ id: 'file_x' }), { failure: 'refused' }],
  ])('ends as a failure for %d %s', async (status, body, failure) => {
    const upload = start();
    FakeRequest.last.answer(status, body);
    expect(await upload.done).toEqual({ ok: false, ...failure });
  });

  it('ends as a connection failure when the request never gets through', async () => {
    const upload = start();
    FakeRequest.last.listeners['error']?.({ loaded: 0 });
    expect(await upload.done).toEqual({ ok: false, failure: 'connection' });
  });

  it('ends as cancelled when it is stopped', async () => {
    const upload = start();
    upload.cancel();
    expect(FakeRequest.last.aborted).toBe(true);
    expect(await upload.done).toEqual({ ok: false, failure: 'cancelled' });
  });
});

describe('the keys lists are kept under', () => {
  it('all sit under the business, so one change refreshes them together', () => {
    const all = mediaKeys.all('biz_test');
    const filter = {
      folderId: null,
      search: '',
      kind: undefined,
      publicOnly: false,
      sort: 'modified_desc' as const,
    };
    for (const key of [
      mediaKeys.list('biz_test', filter),
      mediaKeys.folders('biz_test'),
      mediaKeys.usage('biz_test'),
      mediaKeys.file('biz_test', 'file_x'),
    ])
      expect(key.slice(0, all.length)).toEqual([...all]);
    expect(mediaKeys.all('biz_other')).not.toEqual(all);
  });
});
