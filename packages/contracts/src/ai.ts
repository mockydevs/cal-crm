// Settings → AI models: the providers a business or its agency has connected, which model
// does which job, the spending limit, privacy, prices and what was spent. A provider's key
// is write-only: it is sealed for the worker when it is saved, and no answer here carries
// it. Model ids are the providers' own; nothing here lists them.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** The providers there is an adapter for. A model server of one's own is `openai_compatible`. */
export const aiProviders = ['anthropic', 'openai', 'openai_compatible'] as const;
export type AiProviderKey = (typeof aiProviders)[number];

/** The jobs a text model does, in the order Settings lists them. */
export const aiJobs = ['automation_builder', 'replies', 'briefings', 'sorting'] as const;
export type AiJobKey = (typeof aiJobs)[number];

export const AI_LIMITS = {
  keyLength: 500,
  modelLength: 200,
  addressLength: 2000,
  sourceLength: 500,
  logDays: 365,
  /** The calls Settings shows under "Recent calls". */
  recentCalls: 20,
} as const;

// A key travels in an HTTP header, so it is printable ASCII with no space: a key pasted
// with a line break or a trailing blank is refused here rather than failing at the provider.
const secretKey = z
  .string()
  .min(1, { error: 'Enter the key.' })
  .max(AI_LIMITS.keyLength, { error: `Use at most ${String(AI_LIMITS.keyLength)} characters.` })
  .regex(/^[\x21-\x7e]+$/, {
    error: 'A key has no spaces or line breaks. Paste it again, on its own.',
  })
  .meta({ writeOnly: true, examples: ['sk-ant-api03-…'] });

/** A model's name as its provider lists it: one line, with nothing around it. */
const modelName = z
  .string()
  .trim()
  .min(1, { error: 'Enter the model’s name, as the provider lists it.' })
  .max(AI_LIMITS.modelLength, {
    error: `Use at most ${String(AI_LIMITS.modelLength)} characters.`,
  })
  .regex(/^[^\p{Cc}\s]+$/u, { error: 'A model’s name has no spaces.' })
  .meta({ examples: ['claude-sonnet-5-5'] });

/**
 * A model server's address as a person types it. The server decides whether it may be
 * called: a public https address on the standard port, or a host and port the person who
 * runs the install has listed.
 */
const serverAddress = z
  .string()
  .trim()
  .min(1, { error: 'Enter the server’s address.' })
  .max(AI_LIMITS.addressLength, {
    error: `Use at most ${String(AI_LIMITS.addressLength)} characters.`,
  })
  .meta({ examples: ['http://ollama:11434/v1'] });

/** US dollars for a month, to the cent or finer: digits, and up to four after the point. */
const monthlyAmount = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,4})?$/, { error: 'Enter an amount in dollars, such as 50 or 12.50.' })
  .meta({ examples: ['50'] });

/** US dollars for a million tokens: digits, and up to six after the point. Zero is a price. */
const tokenPrice = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,6})?$/, {
    error: 'Enter a price in dollars for a million tokens, such as 3 or 0.25. Zero is allowed.',
  })
  .meta({ examples: ['2.50'] });

/** An amount the server computed, in US dollars with six places. */
const amount = z.string().meta({ examples: ['0.004200'] });

const modelChoice = z
  .strictObject({ provider: z.enum(aiProviders), model: modelName })
  .meta({ id: 'AiModelChoice' });
export type AiModelChoice = z.output<typeof modelChoice>;

/**
 * Every way a test can end. The first ten are what the provider said; the rest are reasons
 * no request was made. The dashboard has a sentence for each, with what to do about it.
 */
export const aiTestOutcomes = [
  'ok',
  'authentication',
  'billing',
  'rate_limited',
  'unavailable',
  'timeout',
  'invalid_request',
  'invalid_response',
  'blocked_address',
  'not_found',
  'limit_reached',
  'price_unknown',
  'ai_off',
  'key_unreadable',
  'not_supported',
  'no_model',
  'expired',
] as const;
export type AiTestOutcome = (typeof aiTestOutcomes)[number];

/** Why an address was refused when it was saved. */
export const aiAddressProblems = [
  'not_a_url',
  'not_https',
  'has_credentials',
  'port_not_allowed',
  'has_query',
] as const;
export type AiAddressProblem = (typeof aiAddressProblems)[number];

export const connectAiProviderInput = z
  .discriminatedUnion('provider', [
    z.strictObject({ provider: z.literal('anthropic'), apiKey: secretKey }),
    z.strictObject({
      provider: z.literal('openai'),
      apiKey: secretKey,
      /** The model a test calls, and the first one offered for a job. */
      model: modelName,
    }),
    z.strictObject({
      provider: z.literal('openai_compatible'),
      baseUrl: serverAddress,
      model: modelName,
      /** Left out for a server that asks for none. */
      apiKey: secretKey.optional(),
    }),
  ])
  .meta({ id: 'ConnectAiProviderInput' });
export type ConnectAiProviderInput = z.output<typeof connectAiProviderInput>;

export const updateAiConnectionInput = z
  .strictObject({
    /** A new key. Null removes the key of a model server that needs none. */
    apiKey: secretKey.nullable().optional(),
    baseUrl: serverAddress.optional(),
    model: modelName.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    error: 'Change at least one thing.',
  })
  .meta({ id: 'UpdateAiConnectionInput' });
export type UpdateAiConnectionInput = z.output<typeof updateAiConnectionInput>;

/** What the command takes: the connection named in the address, and the changes. */
export const updateAiConnectionCommandInput = z.strictObject({
  id: publicId('ai_connection'),
  changes: updateAiConnectionInput,
});

/** What the worker's job for a test carries: the test's row. Not part of the HTTP API. */
export const aiConnectionTestJob = z.strictObject({ testId: z.uuid() });

export const aiConnection = z
  .strictObject({
    id: publicId('ai_connection'),
    provider: z.enum(aiProviders),
    /** Whose it is: the agency's serve every business of the agency. */
    owner: z.enum(['agency', 'business']),
    /** Whether the request may change it: it is managed where it is owned. */
    canManage: z.boolean(),
    hasKey: z.boolean(),
    /** The last four characters of the key, to tell keys apart. Never more of it. */
    keyLast4: z.string().nullable(),
    /** A model server's address. Null for a hosted provider, and for what is not yours. */
    baseUrl: z.string().nullable(),
    model: z.string().nullable(),
    status: z.enum(['untested', 'working', 'failing']),
    lastTest: z
      .strictObject({
        outcome: z.enum(aiTestOutcomes),
        at: timestamp,
        latencyMs: z.number().int().min(0).nullable(),
      })
      .nullable(),
    /** Who added it, when the request may know. */
    addedBy: z.string().nullable(),
    createdAt: timestamp,
  })
  .meta({ id: 'AiConnection' });
export type AiConnection = z.output<typeof aiConnection>;

export const aiConnectionList = z
  .strictObject({ data: z.array(aiConnection) })
  .meta({ id: 'AiConnectionList' });
export type AiConnectionList = z.output<typeof aiConnectionList>;

export const aiConnectionTest = z
  .strictObject({
    id: publicId('ai_connection_test'),
    connectionId: publicId('ai_connection'),
    /**
     * In a business a test asks the model for one short answer, and that call is on the
     * business's record. At the agency it only asks the provider whether it takes the key.
     */
    kind: z.enum(['model_call', 'key_check']),
    status: z.enum(['pending', 'finished']),
    outcome: z.enum(aiTestOutcomes).nullable(),
    /** How long the provider took to answer. */
    latencyMs: z.number().int().min(0).nullable(),
    /** The call a test made, with its cost, or null when the cost is unknown. */
    call: z
      .strictObject({ id: publicId('ai_request'), costEstimate: amount.nullable() })
      .nullable(),
    createdAt: timestamp,
    finishedAt: timestamp.nullable(),
  })
  .meta({ id: 'AiConnectionTest' });
export type AiConnectionTest = z.output<typeof aiConnectionTest>;

export const aiConnectionSaved = z
  .strictObject({ connection: aiConnection, test: aiConnectionTest })
  .meta({ id: 'AiConnectionSaved' });
export type AiConnectionSaved = z.output<typeof aiConnectionSaved>;

export const startAiConnectionTestInput = z
  .strictObject({ connectionId: publicId('ai_connection') })
  .meta({ id: 'StartAiConnectionTestInput' });

/** Whether a job's model can run as things are, and if not, the one thing in the way. */
export const aiReadiness = ['ready', 'no_key', 'price_needed'] as const;
export type AiReadiness = (typeof aiReadiness)[number];

const settingsFields = {
  /** False turns AI off for the business: no model is called. */
  enabled: z.boolean(),
  /** Whose keys the business's calls use. */
  keySource: z.enum(['agency', 'own']),
  /** US dollars in a calendar month (UTC). Null is no limit. */
  monthlyLimit: monthlyAmount.nullable(),
  atLimit: z.enum(['pause', 'continue']),
  maskContactDetails: z.boolean(),
  /** How long what was said to a model is kept. 0 keeps no log. */
  requestLogDays: z
    .number()
    .int()
    .min(0)
    .max(AI_LIMITS.logDays, {
      error: `Keep the log for at most ${String(AI_LIMITS.logDays)} days.`,
    }),
  /** The model that takes over when a job's own fails. Null is no backup. */
  backup: modelChoice.nullable(),
};

const revision = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .meta({ description: 'What the settings were when they were read: sent back with a change.' });

export const updateAiSettingsInput = z
  .strictObject({
    ...settingsFields,
    /** A model for each job. Null uses the job's default. */
    jobs: z.strictObject({
      automation_builder: modelChoice.nullable(),
      replies: modelChoice.nullable(),
      briefings: modelChoice.nullable(),
      sorting: modelChoice.nullable(),
    }),
    revision,
  })
  .meta({ id: 'UpdateAiSettingsInput' });
export type UpdateAiSettingsInput = z.output<typeof updateAiSettingsInput>;

const jobModel = z.strictObject({
  job: z.enum(aiJobs),
  provider: z.string(),
  model: z.string(),
  /** True when nobody chose: the job runs on its default. */
  isDefault: z.boolean(),
  /** Whether the model passed the project's tests for this job. */
  tested: z.boolean(),
  readiness: z.enum(aiReadiness),
});

export const aiSettings = z
  .strictObject({
    ...settingsFields,
    monthlyLimit: z.string().nullable(),
    backup: z
      .strictObject({
        provider: z.string(),
        model: z.string(),
        readiness: z.enum(aiReadiness),
      })
      .nullable(),
    jobs: z.array(jobModel),
    /** The models that can be chosen now, with the keys the business uses. */
    models: z.array(
      z.strictObject({
        provider: z.enum(aiProviders),
        model: z.string(),
        /** Whether a cost can be worked out for its calls. */
        priced: z.boolean(),
      }),
    ),
    /** When this month's limit was reached, if it was. */
    limitReachedAt: timestamp.nullable(),
    revision,
  })
  .meta({ id: 'AiSettings' });
export type AiSettings = z.output<typeof aiSettings>;

const spend = {
  /** What the calls with a known cost came to. */
  spent: amount,
  calls: z.number().int().min(0),
  /** Finished calls whose cost is unknown: no price for the model, or no usage reported. */
  unknownCostCalls: z.number().int().min(0),
};

export const aiUsage = z
  .strictObject({
    /** The calendar month (UTC) the figures are for. */
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .meta({ examples: ['2026-10'] }),
    ...spend,
    limit: z.string().nullable(),
    byJob: z.array(z.strictObject({ job: z.string(), ...spend })),
    recent: z.array(
      z.strictObject({
        id: publicId('ai_request'),
        startedAt: timestamp,
        job: z.string(),
        provider: z.string(),
        model: z.string(),
        keySource: z.enum(['agency', 'own']),
        status: z.enum(['started', 'ok', 'error', 'refused', 'fell_back']),
        /** Why a call failed: a category, never the provider's words. */
        errorCode: z.string().nullable(),
        costEstimate: amount.nullable(),
        latencyMs: z.number().int().min(0).nullable(),
        inputTokens: z.number().int().min(0),
        outputTokens: z.number().int().min(0),
      }),
    ),
  })
  .meta({ id: 'AiUsage' });
export type AiUsage = z.output<typeof aiUsage>;

export const setAiModelPriceInput = z
  .strictObject({
    provider: z.enum(aiProviders),
    model: modelName,
    inputPerMtok: tokenPrice,
    outputPerMtok: tokenPrice,
    /** Left out, cached input costs what fresh input does. */
    cacheReadPerMtok: tokenPrice.optional(),
    /** A write to the five-minute cache, or to the only cache the provider has. */
    cacheWritePerMtok: tokenPrice.optional(),
    /** A write to Claude's one-hour cache. Left out, calls of this model never ask for it. */
    cacheWrite1hPerMtok: tokenPrice.optional(),
    /** Where the price comes from, such as the provider's pricing page. */
    source: z
      .string()
      .trim()
      .min(1, { error: 'Say where the price comes from.' })
      .max(AI_LIMITS.sourceLength, {
        error: `Use at most ${String(AI_LIMITS.sourceLength)} characters.`,
      })
      .regex(/^\P{Cc}*$/u, { error: 'Use one line of plain text.' }),
  })
  .meta({ id: 'SetAiModelPriceInput' });
export type SetAiModelPriceInput = z.output<typeof setAiModelPriceInput>;

/** A price is named by what it prices: the agency has one for a provider's model. */
export const aiModelPriceKey = z
  .strictObject({ provider: z.enum(aiProviders), model: modelName })
  .meta({ id: 'AiModelPriceKey' });

export const aiModelPrice = z
  .strictObject({
    /**
     * True for a price shipped with the product, which cannot be removed, only replaced by
     * one of the agency's own.
     */
    shipped: z.boolean(),
    provider: z.string(),
    model: z.string(),
    inputPerMtok: amount,
    outputPerMtok: amount,
    cacheReadPerMtok: amount,
    cacheWritePerMtok: amount,
    /** Null when there is no price for the one-hour cache, which is then never used. */
    cacheWrite1hPerMtok: amount.nullable(),
    source: z.string(),
    checkedOn: z.iso.date(),
  })
  .meta({ id: 'AiModelPrice' });
export type AiModelPrice = z.output<typeof aiModelPrice>;

export const aiModelPriceList = z
  .strictObject({
    data: z.array(aiModelPrice),
    /** Whether the request may change prices: they are the agency's. */
    canManage: z.boolean(),
  })
  .meta({ id: 'AiModelPriceList' });
export type AiModelPriceList = z.output<typeof aiModelPriceList>;

const connectionParams = z.strictObject({ id: publicId('ai_connection') });

export const listAiConnections = defineEndpoint({
  operationId: 'listAiConnections',
  method: 'get',
  path: '/ai/connections',
  summary: 'List the AI providers that are connected.',
  group: 'AI',
  response: {
    status: 200,
    description:
      'In a business: its own connections and the agency’s. At the agency: the agency’s. Never a key.',
    schema: aiConnectionList,
  },
});
export const connectAiProvider = defineEndpoint({
  operationId: 'connectAiProvider',
  method: 'post',
  path: '/ai/connections',
  summary: 'Connect an AI provider or a model server, and test it.',
  group: 'AI',
  body: connectAiProviderInput,
  response: {
    status: 201,
    description: 'The connection, and the test that was queued for it; poll the test.',
    schema: aiConnectionSaved,
  },
});
export const updateAiConnection = defineEndpoint({
  operationId: 'updateAiConnection',
  method: 'patch',
  path: '/ai/connections/{id}',
  summary: 'Replace a connection’s key, address or model, and test it again.',
  group: 'AI',
  params: connectionParams,
  body: updateAiConnectionInput,
  response: {
    status: 200,
    description: 'The connection, and the test that was queued for it.',
    schema: aiConnectionSaved,
  },
});
export const removeAiConnection = defineEndpoint({
  operationId: 'removeAiConnection',
  method: 'delete',
  path: '/ai/connections/{id}',
  summary: 'Remove a connection and destroy its key.',
  group: 'AI',
  params: connectionParams,
  response: { status: 204, description: 'The connection and its key are gone.' },
});
export const startAiConnectionTest = defineEndpoint({
  operationId: 'startAiConnectionTest',
  method: 'post',
  path: '/ai/connection-tests',
  summary: 'Test a connection.',
  group: 'AI',
  body: startAiConnectionTestInput,
  response: { status: 201, description: 'The test was queued; poll it.', schema: aiConnectionTest },
});
export const getAiConnectionTest = defineEndpoint({
  operationId: 'getAiConnectionTest',
  method: 'get',
  path: '/ai/connection-tests/{id}',
  summary: 'Read a connection test.',
  group: 'AI',
  params: z.strictObject({ id: publicId('ai_connection_test') }),
  response: { status: 200, description: 'The test, and what it found.', schema: aiConnectionTest },
});
export const getAiSettings = defineEndpoint({
  operationId: 'getAiSettings',
  method: 'get',
  path: '/ai/settings',
  summary: 'Read the business’s AI settings.',
  group: 'AI',
  response: { status: 200, description: 'The settings.', schema: aiSettings },
});
export const updateAiSettings = defineEndpoint({
  operationId: 'updateAiSettings',
  method: 'put',
  path: '/ai/settings',
  summary: 'Change the business’s AI settings.',
  group: 'AI',
  body: updateAiSettingsInput,
  response: { status: 200, description: 'The settings as saved.', schema: aiSettings },
});
export const getAiUsage = defineEndpoint({
  operationId: 'getAiUsage',
  method: 'get',
  path: '/ai/usage',
  summary: 'Read this month’s AI spend and the latest calls.',
  group: 'AI',
  response: {
    status: 200,
    description: 'Spend, by job, and the latest calls. Never what was said in a call.',
    schema: aiUsage,
  },
});
export const listAiModelPrices = defineEndpoint({
  operationId: 'listAiModelPrices',
  method: 'get',
  path: '/ai/model-prices',
  summary: 'List the prices AI costs are worked out from.',
  group: 'AI',
  response: {
    status: 200,
    description:
      'The agency’s prices, and those shipped with the product that it has not replaced.',
    schema: aiModelPriceList,
  },
});
export const setAiModelPrice = defineEndpoint({
  operationId: 'setAiModelPrice',
  method: 'put',
  path: '/ai/model-prices',
  summary: 'Set a model’s price for the agency.',
  group: 'AI',
  body: setAiModelPriceInput,
  response: { status: 200, description: 'The price as saved.', schema: aiModelPrice },
});
export const removeAiModelPrice = defineEndpoint({
  operationId: 'removeAiModelPrice',
  method: 'delete',
  path: '/ai/model-prices',
  summary: 'Remove a price the agency set.',
  group: 'AI',
  query: aiModelPriceKey,
  response: { status: 204, description: 'The price is gone; a shipped price applies again.' },
});

export const aiSettingsEndpoints = [
  listAiConnections,
  connectAiProvider,
  updateAiConnection,
  startAiConnectionTest,
  getAiConnectionTest,
  removeAiConnection,
  getAiSettings,
  updateAiSettings,
  getAiUsage,
  listAiModelPrices,
  setAiModelPrice,
  removeAiModelPrice,
] as const;
