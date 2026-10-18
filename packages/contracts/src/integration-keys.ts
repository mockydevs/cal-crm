import * as z from 'zod';

import { agencyApiKeyScopes, apiKeyReadGroups } from './api-keys.js';
import { SLUG } from './businesses.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { businessSummary } from './me.js';
import { timestamp } from './timestamps.js';

export const listBusinessesQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: publicId('business').optional(),
});

export const listBusinesses = defineEndpoint({
  operationId: 'listBusinesses',
  method: 'get',
  path: '/integration/businesses',
  summary: 'Discover the active businesses available to this account',
  group: 'Businesses',
  query: listBusinessesQuery,
  response: {
    status: 200,
    description:
      'Active businesses in the current account scope, ordered by ID. Use next as after.',
    schema: z.strictObject({
      items: z.array(businessSummary),
      next: publicId('business').nullable(),
    }),
  },
});

export const apiKeyContext = z
  .strictObject({
    scope: z.enum(['agency', 'business']),
    agency: z.strictObject({ name: z.string(), slug: z.string().regex(SLUG) }),
    business: businessSummary.nullable(),
    scopes: z.array(z.enum(agencyApiKeyScopes)),
    readOnly: z.boolean(),
    readGroups: z.array(z.enum(apiKeyReadGroups)).nullable(),
    expiresAt: timestamp.nullable(),
  })
  .meta({
    id: 'ApiKeyContext',
    description: 'The bearer key account and explicit access policy. Never the credential.',
  });

export type ApiKeyContext = z.infer<typeof apiKeyContext>;

export const getApiKeyContext = defineEndpoint({
  operationId: 'getApiKeyContext',
  method: 'get',
  path: '/integration/context',
  summary: 'Read the account and permissions identified by your API key',
  group: 'Account',
  response: {
    status: 200,
    description: 'The key scope and the currently selected account, without requiring an ID.',
    schema: apiKeyContext,
  },
});

export const integrationKeyEndpoints = [listBusinesses, getApiKeyContext] as const;
