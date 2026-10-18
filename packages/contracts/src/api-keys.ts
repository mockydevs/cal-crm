// API keys: made in a business for an app, shown once, and signed in with as
// `Authorization: Bearer crm_live_…`. Their scopes are the permission catalog's keys.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { permissionCatalog, permissions, type Permission } from './permissions.js';
import { timestamp } from './timestamps.js';

/** A key: `crm_live_` and 64 hex digits, 256 random bits. */
export const apiKeyFormat = /^crm_live_[0-9a-f]{64}$/;

/** How much of a key lists show, to tell keys apart: `crm_live_` and 12 hex digits. */
export const API_KEY_PREFIX_LENGTH = 21;

/**
 * Saved views belong to people, so no key can save or share one. AI settings are people's
 * too: a provider's key, and the limit on what it may spend, are not for a program to
 * change. The audit log says what people did, and is for people to read. A conversation
 * with the in-app assistant is one person's: a program uses the assistant's tools through
 * the API itself, with the key's own permissions.
 */
const peopleOnly: readonly Permission[] = [
  'ai.manage',
  'assistant.use',
  'audit.read',
  'views.save',
  'views.share',
];

/** The permissions a key may have: the business's, apart from making keys and what is people's. */
export const apiKeyScopes: readonly Permission[] = permissions.filter(
  (key) =>
    permissionCatalog[key].scope !== 'agency' && key !== 'apps.manage' && !peopleOnly.includes(key),
);

/** Agency keys may hold agency and business grants, never key/person/security management. */
export const agencyApiKeyScopes: readonly Permission[] = permissions.filter(
  (key) => key !== 'apps.manage' && key !== 'agency.security' && !peopleOnly.includes(key),
);

/** Stable API group names used to restrict reads, independently of native write grants. */
export const apiKeyReadGroups = [
  'AI',
  'API keys',
  'Account',
  'Activity',
  'Agency',
  'App Marketplace',
  'Assistant',
  'Assistant conversations',
  'Audit log',
  'Automations',
  'Businesses',
  'Calendars',
  'Calls',
  'Companies',
  'Consent',
  'Contacts',
  'Custom values',
  'Deals',
  'Email',
  'Email campaigns',
  'Fields',
  'Files',
  'Forms',
  'Imports',
  'Inbox',
  'Lead sources',
  'Manual actions',
  'Media storage',
  'Message templates',
  'Notes',
  'Notifications',
  // Custom objects and the associations between objects (GoHighLevel's objects/schema and
  // associations scopes).
  'Objects',
  'Payment settings',
  'Payments',
  'Phone System',
  'Pipelines',
  'Products',
  'Quotes and invoices',
  'Reports',
  'SMS',
  'Scoring',
  'Search',
  'Sites',
  'Snippets',
  'Tags',
  'Tasks',
  'Team',
  'Trash',
  'Trigger links',
  'Users',
  'Views',
  'Web chat',
] as const;
export type ApiKeyReadGroup = (typeof apiKeyReadGroups)[number];

/** These groups require a person's identity; key self-context is the sole Account exception. */
export const apiKeyPersonalGroups: readonly ApiKeyReadGroup[] = [
  'Account',
  'AI',
  'Assistant',
  'Assistant conversations',
  'Audit log',
  'Views',
  'Notifications',
];

/** The catalog offered by key settings; native commands still check protected read grants. */
export const apiKeySelectableReadGroups = apiKeyReadGroups.filter(
  (group) => !apiKeyPersonalGroups.includes(group) && group !== 'Agency',
);

export const apiKey = z
  .looseObject({
    id: publicId('api_key'),
    name: z.string().meta({ examples: ['Zapier'] }),
    prefix: z.string().meta({
      description: 'How the key starts, to tell keys apart. The rest is never shown again.',
      examples: ['crm_live_8f3e2b9c1a0d'],
    }),
    scopes: z
      .array(z.string())
      .meta({ description: 'What the key may change.', examples: [['tags.manage']] }),
    createdAt: timestamp,
    createdBy: z
      .string()
      .nullable()
      .meta({
        description: "Who made it. Null when they're gone, or you can't see them.",
        examples: ['Dana Brooks'],
      }),
    lastUsedAt: timestamp.nullable().meta({ description: 'To the minute. Null if never used.' }),
    scope: z.enum(['agency', 'business']).optional(),
    readOnly: z.boolean().optional(),
    readGroups: z.array(z.enum(apiKeyReadGroups)).nullable().optional().meta({
      description: 'Allowed read groups. Null or absent means legacy unrestricted reads.',
    }),
    expiresAt: timestamp.nullable().optional(),
  })
  .meta({ id: 'ApiKey', description: "A key an app uses for the business's API." });

export type ApiKey = z.infer<typeof apiKey>;

export const createdApiKey = apiKey
  .extend({
    key: z.string().meta({
      description: "The key itself. It's shown only this once: keep it somewhere safe.",
      examples: [`crm_live_${'8f3e2b9c1a0d'.padEnd(64, '0')}`],
    }),
  })
  .meta({ id: 'CreatedApiKey', description: 'A new key, with the key itself.' });

export type CreatedApiKey = z.infer<typeof createdApiKey>;

export const createApiKeyInput = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1, { error: 'Give the key a name, such as the app that uses it.' })
      .max(80, { error: 'Use at most 80 characters.' })
      .meta({ examples: ['Zapier'] }),
    scopes: z
      .array(z.enum(agencyApiKeyScopes))
      .refine((scopes) => new Set(scopes).size === scopes.length, {
        error: 'Choose each permission once.',
      })
      .meta({ description: 'Native permissions. The creator must hold every requested grant.' }),
    readOnly: z.boolean().optional(),
    readGroups: z
      .array(z.enum(apiKeyReadGroups))
      .refine((groups) => new Set(groups).size === groups.length, {
        error: 'Choose each read group once.',
      })
      .nullable()
      .optional()
      .meta({
        description: 'Selected read groups. Omit or use null for legacy unrestricted reads.',
      }),
    expiresAt: timestamp.nullable().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.scopes.length === 0 && (input.readGroups?.length ?? 0) === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['scopes'],
        message:
          input.readGroups === null || input.readGroups === undefined
            ? 'Choose at least one permission.'
            : 'Choose at least one permission or read group.',
      });
    if (
      input.readOnly === true &&
      input.scopes.some((scope) => scope !== 'payments.read' && scope !== 'reports.view')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['scopes'],
        message: 'A read-only key cannot hold write permissions.',
      });
    if (
      input.expiresAt !== null &&
      input.expiresAt !== undefined &&
      Date.parse(input.expiresAt) <= Date.now()
    )
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Choose an expiry in the future.',
      });
  })
  .meta({ id: 'CreateApiKeyInput' });

export type CreateApiKeyInput = z.infer<typeof createApiKeyInput>;

export const apiKeyList = z
  .looseObject({
    items: z.array(apiKey).meta({ description: 'Newest first.' }),
    canManage: z.boolean().meta({ description: 'Whether you may make and revoke keys.' }),
    scopes: z.array(z.enum(agencyApiKeyScopes)).meta({
      description: "The permissions you may give a key: a key's, that you have yourself.",
    }),
    scope: z.enum(['agency', 'business']).optional(),
    readGroups: z.array(z.enum(apiKeyReadGroups)).optional(),
  })
  .meta({ id: 'ApiKeyList', description: "The business's keys that still work." });

export const listApiKeys = defineEndpoint({
  operationId: 'listApiKeys',
  method: 'get',
  path: '/api-keys',
  summary: 'List the API keys',
  group: 'API keys',
  response: {
    status: 200,
    description: "The business's keys that still work.",
    schema: apiKeyList,
  },
});

export const createApiKey = defineEndpoint({
  operationId: 'createApiKey',
  method: 'post',
  path: '/api-keys',
  summary: 'Create an API key',
  group: 'API keys',
  body: createApiKeyInput,
  response: {
    status: 201,
    description: "The new key. It's shown only in this response.",
    schema: createdApiKey,
  },
});

export const revokeApiKey = defineEndpoint({
  operationId: 'revokeApiKey',
  method: 'delete',
  path: '/api-keys/{id}',
  summary: 'Revoke an API key',
  group: 'API keys',
  params: z.object({ id: publicId('api_key') }),
  response: { status: 204, description: 'Revoked: the key fails from its next request.' },
});
