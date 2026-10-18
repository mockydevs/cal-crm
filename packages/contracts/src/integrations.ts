// Settings → Integrations: every connection the business has, on this page or on a page of
// its own, and the connections made here: connect, settings, a check, the activity list and
// disconnect. Credentials are never part of an answer: an API key goes in once, sealed for
// the worker, and an OAuth token never reaches the API at all.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import {
  integrationAuthKinds,
  integrationCategories,
  integrationKey,
  integrationPages,
} from './integrations-catalog.js';
import { timestamp } from './timestamps.js';

export const INTEGRATION_LIMITS = {
  /** An account's name as the provider gives it. */
  accountLabel: 200,
  /** The plain words kept with a failure. */
  errorDetail: 300,
  /** A pasted API key or token. */
  apiKey: 4096,
  /** The activity list's page, and how many the panel shows first. */
  activityPage: 50,
  recentActivity: 20,
  /** How long an OAuth attempt may wait for the provider's answer. */
  attemptMinutes: 10,
} as const;

export const integrationConnectionStatuses = [
  'connecting',
  'connected',
  'needs_attention',
  'disconnected',
] as const;
export type IntegrationConnectionStatus = (typeof integrationConnectionStatuses)[number];

/** Why a connection needs someone, in one word each; the panel says it in plain words. */
export const integrationErrorCodes = [
  'reauthorize',
  'missing_permission',
  'rate_limited',
  'provider_error',
  'plan_limit',
  'config_missing',
] as const;
export type IntegrationErrorCode = (typeof integrationErrorCodes)[number];

/** What a card says about its integration as a whole. */
export const integrationStates = [
  'not_connected',
  'connecting',
  'connected',
  'needs_attention',
] as const;
export type IntegrationState = (typeof integrationStates)[number];

export const integrationConnection = z
  .looseObject({
    id: publicId('integration_connection'),
    accountLabel: z
      .string()
      .nullable()
      .meta({
        description:
          'The account as the provider names it, such as a workspace or a shop. Null until the account has been read.',
        examples: ['Acme Workspace'],
      }),
    status: z.enum(integrationConnectionStatuses),
    errorCode: z.enum(integrationErrorCodes).nullable(),
    errorDetail: z
      .string()
      .nullable()
      .meta({ description: 'What went wrong, in plain words. Null while nothing has.' }),
    primary: z.boolean().meta({ description: 'The account used when a step names none.' }),
    connectedBy: z
      .string()
      .nullable()
      .meta({
        description: "Who connected it. Null when they're gone, or you can't see them.",
        examples: ['Dana Brooks'],
      }),
    connectedAt: timestamp,
    lastOkAt: timestamp.nullable(),
    lastErrorAt: timestamp.nullable(),
    settings: z.record(z.string(), z.unknown()).meta({
      description: "The connection's options, as its integration defines them. Never a secret.",
    }),
    webhookUrl: z.url().nullable().meta({
      description:
        'Where the provider sends its updates for this account, for a provider that sends any. Null for the others, and where the install takes no public requests.',
    }),
    revision: z.int().min(1),
  })
  .meta({ id: 'IntegrationConnection', description: 'A connected account of an integration.' });
export type IntegrationConnection = z.output<typeof integrationConnection>;

export const integrationEntry = z
  .looseObject({
    key: z.string().meta({ examples: ['google_calendar'] }),
    name: z.string().meta({ examples: ['Google Calendar'] }),
    description: z.string(),
    category: z.enum(integrationCategories),
    auth: z.enum([...integrationAuthKinds, 'elsewhere']).meta({
      description:
        'How it is connected: here with the provider’s sign-in (oauth2) or a pasted key (api_key), or on a page of its own (elsewhere).',
    }),
    available: z.boolean().meta({
      description:
        "Whether it can be connected on this install. False: the install's operator has not set it up.",
    }),
    operatorGuide: z
      .string()
      .nullable()
      .meta({
        description:
          "Where the install's operator reads how to set it up: a path in the project's docs.",
        examples: ['docs/HOSTING.md#51-what-you-set'],
      }),
    multipleAccounts: z.boolean(),
    page: z.enum(integrationPages).nullable().meta({
      description: 'The page that manages it, for one that lives elsewhere; null for the others.',
    }),
    mayManage: z.boolean().meta({
      description: 'Whether you may connect and change it, where it is managed.',
    }),
    state: z.enum(integrationStates),
    connected: z.int().min(0).meta({ description: 'Connections that work.' }),
    attention: z.int().min(0).meta({ description: 'Connections that need someone.' }),
    label: z.string().nullable().meta({
      description: 'The one connected account’s name; null with none or several.',
    }),
    connections: z.array(integrationConnection).meta({
      description:
        'The accounts connected on this page, primary first; none for an integration managed elsewhere.',
    }),
  })
  .meta({ id: 'IntegrationEntry', description: 'One card of Settings → Integrations.' });
export type IntegrationEntry = z.output<typeof integrationEntry>;

export const integrationList = z
  .looseObject({
    entries: z.array(integrationEntry),
    canManage: z.boolean().meta({
      description: 'Whether you may connect, change and disconnect integrations made here.',
    }),
  })
  .meta({ id: 'IntegrationList', description: "The business's integrations." });
export type IntegrationList = z.output<typeof integrationList>;

export const integrationActivityKinds = [
  'connected',
  'confirmed',
  'check_ok',
  'check_failed',
  'webhook_received',
  'settings_changed',
  'disconnected',
  'revoked',
] as const;
export type IntegrationActivityKind = (typeof integrationActivityKinds)[number];

export const integrationActivity = z
  .looseObject({
    connectionId: publicId('integration_connection'),
    at: timestamp,
    kind: z.enum(integrationActivityKinds),
    errorCode: z.enum(integrationErrorCodes).nullable(),
    detail: z.string().nullable().meta({ description: 'Plain words, never a secret.' }),
  })
  .meta({ id: 'IntegrationActivity', description: 'Something that happened to a connection.' });
export type IntegrationActivity = z.output<typeof integrationActivity>;

export const integrationDetail = z
  .looseObject({
    entry: integrationEntry,
    activity: z
      .array(integrationActivity)
      .meta({ description: 'The latest activity of its connections, newest first.' }),
  })
  .meta({ id: 'IntegrationDetail', description: 'One integration, as its Manage panel shows it.' });
export type IntegrationDetail = z.output<typeof integrationDetail>;

export const integrationParams = z.strictObject({ provider: integrationKey });
export const integrationConnectionParams = z.strictObject({
  provider: integrationKey,
  id: publicId('integration_connection'),
});

export const connectIntegrationInput = z.strictObject({
  apiKey: z
    .string()
    .trim()
    .min(1, { error: 'Paste the key.' })
    .max(INTEGRATION_LIMITS.apiKey, { error: 'That is longer than any key.' })
    .optional()
    .meta({ description: 'For an integration connected with a key: the key, used once.' }),
});
export type ConnectIntegrationInput = z.input<typeof connectIntegrationInput>;

export const integrationConnectStarted = z
  .looseObject({
    authorizeUrl: z.url().nullable().meta({
      description:
        "For one connected with the provider's sign-in: open it to give consent. It can be used once, for ten minutes.",
    }),
    connection: integrationConnection.nullable().meta({
      description: 'For one connected with a key: the connection, connecting until it is checked.',
    }),
  })
  .meta({ id: 'IntegrationConnectStarted' });
export type IntegrationConnectStarted = z.output<typeof integrationConnectStarted>;

export const updateIntegrationConnectionInput = z.strictObject({
  primary: z.literal(true).optional().meta({ description: 'Make it the primary account.' }),
  settings: z.record(z.string(), z.unknown()).optional(),
  /** The revision the change was made to: an older one is refused, nothing is overwritten. */
  revision: z.int().min(1),
});
export type UpdateIntegrationConnectionInput = z.input<typeof updateIntegrationConnectionInput>;

export const integrationActivityQuery = z.strictObject({
  before: timestamp.optional().meta({ description: 'Only what happened before this moment.' }),
});

export const integrationActivityPage = z
  .looseObject({
    items: z.array(integrationActivity),
    next: timestamp.nullable().meta({ description: 'Pass as before for the next page.' }),
  })
  .meta({ id: 'IntegrationActivityPage' });

/** What happened where the provider sent the browser back, as the page is told. */
export const integrationConnectOutcomes = [
  'connected',
  'denied',
  'scopes_missing',
  'expired',
  'failed',
] as const;
export type IntegrationConnectOutcome = (typeof integrationConnectOutcomes)[number];

const group = 'Integrations';

export const listIntegrations = defineEndpoint({
  operationId: 'listIntegrations',
  method: 'get',
  path: '/integrations',
  group,
  summary: "List the business's integrations and the state of each",
  response: { status: 200, description: 'The integrations.', schema: integrationList },
});

export const getIntegration = defineEndpoint({
  operationId: 'getIntegration',
  method: 'get',
  path: '/integrations/{provider}',
  group,
  summary: 'Read one integration: its accounts and their latest activity',
  params: integrationParams,
  response: { status: 200, description: 'The integration.', schema: integrationDetail },
});

export const connectIntegration = defineEndpoint({
  operationId: 'connectIntegration',
  method: 'post',
  path: '/integrations/{provider}/connect',
  group,
  summary: 'Start connecting an account of an integration',
  params: integrationParams,
  body: connectIntegrationInput,
  response: {
    status: 201,
    description:
      'The provider’s consent address, or the connection made with the key and queued for a check.',
    schema: integrationConnectStarted,
  },
});

export const updateIntegrationConnection = defineEndpoint({
  operationId: 'updateIntegrationConnection',
  method: 'patch',
  path: '/integrations/{provider}/connections/{id}',
  group,
  summary: "Change a connection's options, or make it the primary account",
  params: integrationConnectionParams,
  body: updateIntegrationConnectionInput,
  response: { status: 200, description: 'The connection.', schema: integrationConnection },
});

export const testIntegrationConnection = defineEndpoint({
  operationId: 'testIntegrationConnection',
  method: 'post',
  path: '/integrations/{provider}/connections/{id}/test',
  group,
  summary: 'Check a connection with its provider now',
  params: integrationConnectionParams,
  response: {
    status: 200,
    description: 'The connection; the check is queued and its answer shows in the activity.',
    schema: integrationConnection,
  },
});

export const disconnectIntegration = defineEndpoint({
  operationId: 'disconnectIntegration',
  method: 'delete',
  path: '/integrations/{provider}/connections/{id}',
  group,
  summary: 'Disconnect an account',
  params: integrationConnectionParams,
  response: {
    status: 204,
    description:
      'Disconnected: its steps stop, access is revoked at the provider where it can be, and its credentials are removed. What it already brought in stays.',
  },
});

export const listIntegrationActivity = defineEndpoint({
  operationId: 'listIntegrationActivity',
  method: 'get',
  path: '/integrations/{provider}/connections/{id}/activity',
  group,
  summary: "Read a connection's activity, newest first",
  params: integrationConnectionParams,
  query: integrationActivityQuery,
  response: { status: 200, description: 'A page of activity.', schema: integrationActivityPage },
});

export const integrationEndpoints = [
  listIntegrations,
  getIntegration,
  connectIntegration,
  updateIntegrationConnection,
  testIntegrationConnection,
  disconnectIntegration,
  listIntegrationActivity,
] as const;
