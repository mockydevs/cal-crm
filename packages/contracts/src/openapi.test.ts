import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { getApiKeyContext, listBusinesses } from './integration-keys.js';
import { SLUG } from './businesses.js';

import { defineEndpoint, endpoints } from './index.js';
import { openApiDocument } from './openapi.js';

const render = () => `${JSON.stringify(openApiDocument(), null, 2)}\n`;

describe('the OpenAPI document', () => {
  it('documents optional key account selection without requiring an account ID at connection', () => {
    const document = openApiDocument([getApiKeyContext, listBusinesses]);
    const parameters = document.paths?.[getApiKeyContext.path]?.get?.parameters;
    const selected = parameters?.find(
      (parameter) => 'name' in parameter && parameter.name === 'Business-Slug',
    );
    expect(selected).toMatchObject({
      in: 'header',
      name: 'Business-Slug',
      schema: { type: 'string', pattern: SLUG.source },
    });
    expect(selected).not.toMatchObject({ required: true });
  });
  it('describes a public capability operation without a business-selection header', () => {
    const publicAppointment = defineEndpoint({
      operationId: 'publicAppointmentExample',
      method: 'get',
      path: '/public/appointments/{token}',
      summary: 'Read an appointment through its private capability',
      group: 'Public booking',
      audience: 'public',
      params: z.strictObject({ token: z.string() }),
      response: { status: 200, description: 'Public appointment.' },
    });
    const operation = openApiDocument([publicAppointment]).paths?.[publicAppointment.path]?.get;
    expect(operation?.security).toEqual([]);
    expect(operation?.parameters).toEqual([
      { in: 'path', name: 'token', required: true, schema: { type: 'string' } },
    ]);
  });
  // openapi.json is the reviewed contract. A contract change fails here until the file is
  // regenerated (pnpm --filter @repo/contracts openapi) and the diff is reviewed with it.
  it('matches the reviewed openapi.json', async () => {
    await expect(render()).toMatchFileSnapshot('../openapi.json');
  });

  it('comes out the same every time', () => {
    expect(render()).toBe(render());
  });

  it('is OpenAPI 3.1, served under /api/v1, with an operation for every endpoint', () => {
    const document = openApiDocument();

    expect(document.openapi).toBe('3.1.0');
    expect(document.servers).toEqual([{ url: '/api/v1' }]);
    for (const endpoint of endpoints) {
      expect(document.paths?.[endpoint.path]?.[endpoint.method]).toMatchObject({
        operationId: endpoint.operationId,
        summary: endpoint.summary,
      });
    }
  });

  it('describes errors as problem details on every operation', () => {
    const document = openApiDocument();

    for (const endpoint of endpoints) {
      expect(document.paths?.[endpoint.path]?.[endpoint.method]?.responses).toMatchObject({
        default: {
          content: {
            'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
          },
        },
      });
    }
  });

  // A request names the business it works in; without one, agency staff work at the agency
  // and a business user in their only business.
  it('lets every operation name the business it works in, with a Business-Id header', () => {
    const document = openApiDocument();

    for (const endpoint of endpoints) {
      expect(document.paths?.[endpoint.path]?.[endpoint.method]?.parameters).toContainEqual(
        expect.objectContaining({
          in: 'header',
          name: 'Business-Id',
          schema: expect.objectContaining({
            pattern: expect.stringContaining('biz_') as unknown,
          }) as unknown,
        }),
      );
    }
  });

  it('gives every operation a unique operationId', () => {
    const ids = endpoints.map((endpoint) => endpoint.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('describes path and query parameters, and answers with no content', () => {
    const id = z.object({ id: z.string() });
    const getThing = defineEndpoint({
      operationId: 'getThing',
      method: 'get',
      path: '/things/{id}',
      summary: 'Get a thing',
      group: 'Things',
      params: id,
      query: z.object({ include: z.string().optional() }),
      response: { status: 200, description: 'The thing.', schema: id },
    });
    const deleteThing = defineEndpoint({
      operationId: 'deleteThing',
      method: 'delete',
      path: '/things/{id}',
      summary: 'Delete a thing',
      group: 'Things',
      params: id,
      response: { status: 204, description: 'Deleted.' },
    });

    const paths = openApiDocument([getThing, deleteThing]).paths?.['/things/{id}'];

    expect(paths?.get?.parameters).toMatchObject([
      { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
      { in: 'query', name: 'include', schema: { type: 'string' } },
      { in: 'header', name: 'Business-Id' },
      { in: 'header', name: 'Business-Slug' },
    ]);
    expect(paths?.delete?.parameters).toMatchObject([
      { in: 'path', name: 'id' },
      { in: 'header', name: 'Business-Id' },
      { in: 'header', name: 'Business-Slug' },
    ]);
    expect(paths?.delete?.responses?.['204']).toEqual({ description: 'Deleted.' });
  });

  // OpenAPI 3.1 (section 4.8.14.3): a file sent as the whole body is a media type with no schema.
  it("describes an upload as the request's raw content, in each type it takes", () => {
    const putPicture = defineEndpoint({
      operationId: 'putPicture',
      method: 'post',
      path: '/pictures',
      summary: 'Upload a picture',
      group: 'Pictures',
      upload: { types: ['image/png', 'image/jpeg'] },
      response: { status: 204, description: 'Stored.' },
    });

    const operation = openApiDocument([putPicture]).paths?.['/pictures']?.post;

    expect(operation?.requestBody).toEqual({
      required: true,
      content: { 'image/png': {}, 'image/jpeg': {} },
    });
  });
});
