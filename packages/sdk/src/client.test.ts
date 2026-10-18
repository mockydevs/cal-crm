import {
  createTag,
  defineEndpoint,
  getSalesDocumentPdf,
  listTags,
  publicId,
  tag,
  uploadFile,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { ApiError, createClient, type RequestOptions } from './index.js';

const hotLead = {
  id: 'tag_01h455vb4pex5vsknk084sn02q',
  name: 'Hot lead',
  description: '',
  createdAt: '2026-10-07T09:30:00.000Z',
  updatedAt: '2026-10-07T09:30:00.000Z',
};

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch that records what it was sent and answers with the given response. */
function fakeFetch(answer: () => Response) {
  const sent: Sent[] = [];
  const fetch = (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return Promise.resolve(answer());
  };
  return { fetch, sent };
}

const json = (body: unknown, status: number, contentType = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });

// A read by id, to exercise path parameters and a query string.
const getTag = defineEndpoint({
  operationId: 'getTag',
  method: 'get',
  path: '/tags/{id}',
  summary: 'Get a tag',
  group: 'Tags',
  params: z.object({ id: publicId('tag') }),
  query: z.object({ include: z.string().optional(), limit: z.number().optional() }),
  response: { status: 200, description: 'The tag.', schema: tag },
});

const deleteTag = defineEndpoint({
  operationId: 'deleteTag',
  method: 'delete',
  path: '/tags/{id}',
  summary: 'Delete a tag',
  group: 'Tags',
  params: z.object({ id: publicId('tag') }),
  response: { status: 204, description: 'Deleted.' },
});

describe('createClient', () => {
  it('sends the body as JSON to the endpoint, with the headers, and returns the parsed answer', async () => {
    const { fetch, sent } = fakeFetch(() => json(hotLead, 201));
    const client = createClient({
      baseUrl: 'https://crm.example.com/api/v1/',
      fetch,
      headers: () => ({ authorization: 'Bearer key' }),
    });

    const created = await client.request(createTag, { body: { name: 'Hot lead' } });

    expect(created).toEqual(hotLead);
    expect(sent).toEqual([
      {
        url: 'https://crm.example.com/api/v1/tags',
        method: 'POST',
        headers: {
          accept: 'application/json, application/problem+json',
          authorization: 'Bearer key',
          'content-type': 'application/json',
        },
        body: '{"name":"Hot lead"}',
      },
    ]);
  });

  it("uploads a file as the request's raw body, in its own type", async () => {
    const stored = {
      id: 'file_01h455vb4pex5vsknk084sn02q',
      filename: 'logo.png',
      contentType: 'image/png',
      size: 3,
      sha256: 'a'.repeat(64),
      createdAt: '2026-10-07T09:30:00.000Z',
    };
    const bodies: unknown[] = [];
    const { fetch, sent } = fakeFetch(() => json(stored, 201));
    const recording = (url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body);
      return fetch(url, init);
    };
    const client = createClient({ baseUrl: '/api/v1', fetch: recording });
    const content = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

    const file = await client.request(uploadFile, {
      query: { filename: 'logo.png' },
      upload: { content, type: 'image/png' },
    });

    expect(file).toEqual(stored);
    expect(sent[0]).toMatchObject({
      url: '/api/v1/files?filename=logo.png',
      method: 'POST',
      headers: { 'content-type': 'image/png' },
    });
    expect(bodies).toEqual([content]);
  });

  it('answers a download endpoint with the file: its bytes, its type and its name', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const { fetch, sent } = fakeFetch(
      () =>
        new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename="INV-0007.pdf"; filename*=UTF-8''INV-0007.pdf`,
          },
        }),
    );
    const client = createClient({ baseUrl: '/api/v1', fetch });

    const file = await client.request(getSalesDocumentPdf, {
      params: { id: 'sdoc_01h455vb4pex5vsknk084sn02q' },
    });

    expect(file).toEqual({
      content: bytes,
      contentType: 'application/pdf',
      filename: 'INV-0007.pdf',
    });
    expect(sent[0]).toMatchObject({
      url: '/api/v1/sales-documents/sdoc_01h455vb4pex5vsknk084sn02q/pdf',
      method: 'GET',
      headers: { accept: 'application/pdf, application/problem+json' },
    });
  });

  it('reads a download’s name in full when it has letters a plain header cannot hold', async () => {
    const answer = (disposition: string | undefined) =>
      createClient({
        baseUrl: '/api/v1',
        fetch: fakeFetch(
          () =>
            new Response(new Uint8Array([1]), {
              status: 200,
              headers: {
                'content-type': 'application/pdf; charset=binary',
                ...(disposition === undefined ? {} : { 'content-disposition': disposition }),
              },
            }),
        ).fetch,
      }).request(getSalesDocumentPdf, { params: { id: 'sdoc_01h455vb4pex5vsknk084sn02q' } });

    expect(
      await answer(`attachment; filename="Fa_ctura.pdf"; filename*=UTF-8''Fa%C3%A7tura.pdf`),
    ).toMatchObject({ filename: 'Façtura.pdf', contentType: 'application/pdf' });
    // A name that is not encoded as it says falls back to the plain one, and none to none.
    expect(
      (await answer(`attachment; filename="plain.pdf"; filename*=UTF-8''%E0%A4%A`)).filename,
    ).toBe('plain.pdf');
    expect((await answer(undefined)).filename).toBe('');
  });

  it('reports a download that fails as the problem it was answered with', async () => {
    const { fetch } = fakeFetch(() =>
      json(
        { type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such document.' },
        404,
        'application/problem+json',
      ),
    );
    const client = createClient({ baseUrl: '/api/v1', fetch });
    await expect(
      client.request(getSalesDocumentPdf, { params: { id: 'sdoc_01h455vb4pex5vsknk084sn02q' } }),
    ).rejects.toMatchObject({ status: 404, message: 'No such document.' });
  });

  it('names the business it works in, as it is when each request goes out', async () => {
    const { fetch, sent } = fakeFetch(() => json({ items: [] }, 200));
    let business: string | undefined = 'biz_01h455vb4pex5vsknk084sn02q';
    const client = createClient({ baseUrl: '/api/v1', fetch, business: () => business });

    await client.request(listTags, {});
    business = undefined;
    await client.request(listTags, {});

    expect(sent.map((request) => request.headers['business-id'])).toEqual([
      'biz_01h455vb4pex5vsknk084sn02q',
      undefined,
    ]);
  });

  it('targets concurrent calls by slug without carrying a legacy business id or changing later calls', async () => {
    const { fetch, sent } = fakeFetch(() => json(hotLead, 201));
    let releaseHeaders: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      releaseHeaders = resolve;
    });
    let calls = 0;
    const client = createClient({
      baseUrl: '/api/v1',
      fetch,
      business: () => 'biz_legacy',
      headers: async () => {
        if (++calls === 1) await waiting;
        return {
          authorization: 'Bearer test-only-key',
          ...(calls <= 2 ? { 'Business-Id': 'biz_header' } : {}),
        };
      },
    });
    const input = Object.freeze({ body: Object.freeze({ name: 'Hot lead' }) });
    const target: RequestOptions = { businessSlug: 'harbor-lights' };
    const first = client.request(createTag, input, target);
    await client.request(createTag, input, { businessSlug: 'bluebird' });
    releaseHeaders?.();
    await first;
    await client.request(createTag, input);

    expect(sent.map(({ headers }) => headers['business-slug'])).toEqual([
      'bluebird',
      'harbor-lights',
      undefined,
    ]);
    expect(sent.slice(0, 2).map(({ headers }) => headers['business-id'])).toEqual([
      undefined,
      undefined,
    ]);
    expect(sent[2]?.headers['business-id']).toBe('biz_legacy');
    expect(sent.map(({ body }) => body)).toEqual(Array<string>(3).fill('{"name":"Hot lead"}'));
    expect(sent[0]?.headers['authorization']).toBe('Bearer test-only-key');
    expect(input).toEqual({ body: { name: 'Hot lead' } });
  });

  it('replaces every case variant of both selectors without mutating reusable headers', async () => {
    const { fetch, sent } = fakeFetch(() => json({ items: [] }, 200));
    const headers = Object.freeze({
      'Business-Id': 'biz_legacy',
      'BUSINESS-ID': 'biz_other',
      'Business-Slug': 'old-business',
      'BUSINESS-SLUG': 'another-business',
      authorization: 'Bearer test-only-key',
    });
    const client = createClient({ baseUrl: '/api/v1', fetch, headers: () => headers });
    await client.request(listTags, {}, { businessSlug: 'harbor-lights' });
    expect(sent[0]?.headers).toEqual({
      accept: 'application/json, application/problem+json',
      authorization: 'Bearer test-only-key',
      'business-slug': 'harbor-lights',
    });
    expect(headers['Business-Id']).toBe('biz_legacy');
    expect(headers['Business-Slug']).toBe('old-business');
    await client.request(listTags, {});
    expect(sent[1]?.headers['business-id']).toBe('biz_legacy, biz_other');
    expect(sent[1]?.headers['business-slug']).toBe('old-business, another-business');
  });
  it('uses key-only scope by default and keeps selectors out of path and query input', async () => {
    const { fetch, sent } = fakeFetch(() => json(hotLead, 200));
    const client = createClient({ baseUrl: '/api/v1', fetch });
    const input = { params: { id: hotLead.id }, query: { include: 'usage & counts', limit: 20 } };
    await client.request(getTag, input);
    await client.request(getTag, input, { businessSlug: 'harbor-lights' });
    await client.request(getTag, input, {});
    expect(sent.map(({ url }) => url)).toEqual(
      Array<string>(3).fill(
        '/api/v1/tags/tag_01h455vb4pex5vsknk084sn02q?include=usage+%26+counts&limit=20',
      ),
    );
    expect(sent.map(({ headers }) => headers['business-slug'])).toEqual([
      undefined,
      'harbor-lights',
      undefined,
    ]);
    expect(
      sent.every(({ headers, body }) => headers['business-id'] === undefined && body === undefined),
    ).toBe(true);
    expect(input).toEqual({
      params: { id: hotLead.id },
      query: { include: 'usage & counts', limit: 20 },
    });
  });

  it.each([403, 422])('preserves the API refusal for a targeted request: %i', async (status) => {
    const details = { type: 'about:blank', title: 'Refused', status, detail: 'Target refused.' };
    const { fetch, sent } = fakeFetch(() => json(details, status, 'application/problem+json'));
    const client = createClient({ baseUrl: '/api/v1', fetch });
    await expect(
      client.request(listTags, {}, { businessSlug: 'harbor-lights' }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status,
      problem: details,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers['business-slug']).toBe('harbor-lights');
  });

  it('fills in path parameters and the query, escaped, against a relative base', async () => {
    const { fetch, sent } = fakeFetch(() => json(hotLead, 200));
    const client = createClient({ baseUrl: '/api/v1', fetch });

    await client.request(getTag, {
      params: { id: 'tag_01h455vb4pex5vsknk084sn02q' },
      query: { include: 'usage & counts', limit: 20 },
    });

    expect(sent[0]?.url).toBe(
      '/api/v1/tags/tag_01h455vb4pex5vsknk084sn02q?include=usage+%26+counts&limit=20',
    );
    expect(sent[0]?.body).toBeUndefined();
  });

  it('leaves out query values that are not given', async () => {
    const { fetch, sent } = fakeFetch(() => json(hotLead, 200));
    const client = createClient({ baseUrl: '/api/v1', fetch });

    await client.request(getTag, { params: { id: 'tag_01h455vb4pex5vsknk084sn02q' }, query: {} });

    expect(sent[0]?.url).toBe('/api/v1/tags/tag_01h455vb4pex5vsknk084sn02q');
  });

  it('returns nothing for an endpoint that answers without content', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    const client = createClient({ baseUrl: '/api/v1', fetch });

    await expect(
      client.request(deleteTag, { params: { id: 'tag_01h455vb4pex5vsknk084sn02q' } }),
    ).resolves.toBeUndefined();
  });

  it('checks the answer against the contract', async () => {
    const { fetch } = fakeFetch(() => json({ items: [{ ...hotLead, id: 'not-a-tag-id' }] }, 200));
    const client = createClient({ baseUrl: '/api/v1', fetch });

    await expect(client.request(listTags, {})).rejects.toThrow(z.ZodError);
  });

  it('throws an ApiError carrying the problem details', async () => {
    const details = {
      type: 'about:blank',
      title: 'Unprocessable Content',
      status: 422,
      detail: '/name: Give the tag a name.',
      errors: [{ path: '/name', code: 'too_small', message: 'Give the tag a name.' }],
    };
    const { fetch } = fakeFetch(() => json(details, 422, 'application/problem+json'));
    const client = createClient({ baseUrl: '/api/v1', fetch });

    const error: unknown = await client
      .request(createTag, { body: { name: '' } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, problem: details, message: details.detail });
  });

  it('makes up the problem when an error answer is not problem details', async () => {
    const { fetch } = fakeFetch(
      () => new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const client = createClient({ baseUrl: '/api/v1', fetch });

    const error: unknown = await client.request(listTags, {}).catch((e: unknown) => e);

    expect(error).toMatchObject({
      status: 502,
      problem: { type: 'about:blank', title: 'Bad Gateway', status: 502 },
      message: 'Bad Gateway',
    });
  });

  it('refuses a success status other than the one in the contract', async () => {
    const { fetch } = fakeFetch(() => json(hotLead, 200));
    const client = createClient({ baseUrl: '/api/v1', fetch });

    await expect(client.request(createTag, { body: { name: 'Hot lead' } })).rejects.toThrow(
      'createTag answered 200, but its contract says 201.',
    );
  });

  it('uses the global fetch when none is given', async () => {
    const original = globalThis.fetch;
    const { fetch, sent } = fakeFetch(() => json({ items: [] }, 200));
    globalThis.fetch = fetch;
    try {
      await createClient({ baseUrl: '/api/v1' }).request(listTags, {});
    } finally {
      globalThis.fetch = original;
    }

    expect(sent).toHaveLength(1);
  });
});
