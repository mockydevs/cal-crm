// The OpenAPI 3.1 document, generated from the contracts with zod-openapi. The reviewed
// copy is openapi.json; a test fails when the two differ.
import {
  createDocument,
  type ZodOpenApiOperationObject,
  type ZodOpenApiPathsObject,
} from 'zod-openapi';

import * as z from 'zod';

import { endpoints } from './api.js';
import { SLUG } from './businesses.js';
import type { Endpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { problem, PROBLEM_CONTENT_TYPE } from './problems.js';

// Every request may name the business it works in.
const workingIn = z.object({
  'Business-Id': publicId('business').optional().meta({
    description:
      'Optional legacy account selector. An API key already identifies its account. Do not combine with Business-Slug. Cookie users retain their workplace rules.',
  }),
  'Business-Slug': z.string().regex(SLUG).optional().meta({
    description:
      'API keys only: optional per-request business slug from account discovery. The key must permit that active account. Omit both selectors to use the key account; no location ID is needed to connect.',
  }),
});

function operation(endpoint: Endpoint): ZodOpenApiOperationObject {
  const { status, description, schema } = endpoint.response;
  return {
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    tags: [endpoint.group],
    // OpenAPI 3.1 section 4.8.10.1: [] removes inherited authentication requirements.
    ...(endpoint.audience === 'public' ? { security: [] } : {}),
    requestParams: {
      ...(endpoint.params === undefined ? {} : { path: endpoint.params }),
      ...(endpoint.query === undefined ? {} : { query: endpoint.query }),
      ...(endpoint.audience === 'public' ? {} : { header: workingIn }),
    },
    ...(endpoint.body === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: endpoint.body } },
          },
        }),
    // OpenAPI 3.1 (section 4.8.14.3): a file sent as the whole body has no schema.
    ...(endpoint.upload === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: Object.fromEntries(endpoint.upload.types.map((type) => [type, {}])),
          },
        }),
    responses: {
      [String(status)]: {
        description,
        ...(schema === undefined ? {} : { content: { 'application/json': { schema } } }),
        // A file as the whole answer has no schema either (section 4.8.14.3).
        ...(endpoint.download === undefined
          ? {}
          : { content: Object.fromEntries(endpoint.download.types.map((type) => [type, {}])) }),
      },
      default: {
        description: 'An error, as problem details (RFC 9457).',
        content: { [PROBLEM_CONTENT_TYPE]: { schema: problem } },
      },
    },
  };
}

/** The OpenAPI document for these endpoints: the whole API unless others are given. */
export function openApiDocument(
  operations: readonly Endpoint[] = endpoints,
): ReturnType<typeof createDocument> {
  const paths: ZodOpenApiPathsObject = {};
  for (const endpoint of operations) {
    paths[endpoint.path] = { ...paths[endpoint.path], [endpoint.method]: operation(endpoint) };
  }
  return createDocument({
    openapi: '3.1.0',
    info: {
      title: 'CRM API',
      version: '1',
      description: 'Everything the dashboard can do. Errors are RFC 9457 problem details.',
    },
    servers: [{ url: '/api/v1' }],
    paths,
  });
}
